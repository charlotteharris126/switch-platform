"use client";

// Employer-lead outcome buttons. Parallel to <OutcomeButtons> (which is
// learner-shaped) — chosen by LeadDetailView based on submission.lead_type.
//
// Workflow mirrors learner on the front half (attempt counter) and is
// B2B-specific on the back half:
//   open → attempt_1 → attempt_2 → attempt_3 → cannot_reach (closure)
//         ↘                                  ↗
//          → engaged → in_progress → signed (or not_signed at any point)
//
// SLA: 1 working day to first attempt, 3 attempts over a fortnight before
// cannot_reach. Stale-attempt threshold = 120h (5 days) per attempt step,
// vs 36h for learner.
//
// presumed_employer_signed is system-driven (60-day cron auto-flip) and
// can't be set from the portal.

import { useTransition, useState } from "react";
import {
  isAllowedTransition,
  NOT_SIGNED_REASON_LABEL,
  STATUS_LABEL,
  VALID_NOT_SIGNED_REASONS,
  type LeadStatus,
  type NotSignedReason,
} from "@/lib/lead-status";

// Linear stepper covering every "still working it" position. Closeouts
// (cannot_reach, not_signed) sit below as separate buttons.
const STEPPER_PATH: ReadonlyArray<LeadStatus> = [
  "open",
  "attempt_1_no_answer",
  "attempt_2_no_answer",
  "attempt_3_no_answer",
  "engaged",
  "in_progress",
  "signed",
];

const STEPPER_SHORT_LABEL: Record<LeadStatus, string> = {
  open: "Open",
  attempt_1_no_answer: "1st",
  attempt_2_no_answer: "2nd",
  attempt_3_no_answer: "3rd",
  engaged: "Engaged",
  in_progress: "In progress",
  signed: "Signed",
  // Fillers — not on this stepper but typed to keep the Record exhaustive.
  enrolment_meeting_booked: "Meeting",
  enrolled: "Enrolled",
  lost: "Lost",
  cannot_reach: "Cannot reach",
  presumed_enrolled: "Presumed",
  not_signed: "Not signed",
  presumed_employer_signed: "Presumed",
};

interface Props {
  submissionId: number;
  currentStatus: LeadStatus;
  onMark: (args: {
    submissionId: number;
    status: string;
    lostReason?: string | null;
    outcomeNote?: string | null;
  }) => Promise<{ ok: boolean; error?: string }>;
}

const OUTCOME_NOTE_MAX = 500;
const ATTEMPT_STATES = new Set<LeadStatus>([
  "open",
  "attempt_1_no_answer",
  "attempt_2_no_answer",
  "attempt_3_no_answer",
]);

export function EmployerOutcomeButtons({ submissionId, currentStatus, onMark }: Props) {
  const [pending, startTransition] = useTransition();
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCloseout, setShowCloseout] = useState<"cannot_reach" | "not_signed" | null>(null);
  const [notSignedReason, setNotSignedReason] = useState<NotSignedReason>("decided_not_to_proceed");
  const [outcomeNote, setOutcomeNote] = useState("");

  const isClosedOut = currentStatus === "presumed_employer_signed";

  function fire(value: LeadStatus, reason?: NotSignedReason) {
    setError(null);
    setPendingValue(value);
    const noteToSend = value === "not_signed" || value === "cannot_reach"
      ? outcomeNote.trim() || null
      : null;
    startTransition(async () => {
      const result = await onMark({
        submissionId,
        status: value,
        lostReason: value === "not_signed" ? reason ?? null : null,
        outcomeNote: noteToSend,
      });
      if (!result.ok) setError(result.error ?? "Failed to update");
      setPendingValue(null);
      if (result.ok) {
        setOutcomeNote("");
        setShowCloseout(null);
      }
    });
  }

  if (isClosedOut) {
    return (
      <div className="mt-4 text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-md p-3">
        This lead is settled at <strong>{STATUS_LABEL[currentStatus]}</strong>.
        No further outcomes can be set from the portal. Email support@switchleads.co.uk if
        anything needs unwinding.
      </div>
    );
  }

  // Off-path: cannot_reach — closed, but the employer might still come
  // back. Allow recovery into engaged/in_progress/signed.
  if (currentStatus === "cannot_reach") {
    return (
      <div className="mt-4 space-y-3">
        <div className="text-sm text-slate-600 bg-amber-50 border border-amber-200 rounded-md p-3">
          Marked <strong>Cannot reach</strong>. If the employer comes back you can
          still move them to <em>Engaged</em>, <em>In progress</em>, or directly to <em>Signed</em>.
        </div>
        <div className="flex flex-wrap gap-2">
          {(["engaged", "in_progress", "signed"] as LeadStatus[]).map((s) => (
            <SecondaryButton
              key={s}
              label={STATUS_LABEL[s]}
              pending={pending && pendingValue === s}
              disabled={pending}
              onClick={() => fire(s)}
            />
          ))}
        </div>
        {error && <ErrorLine message={error} />}
      </div>
    );
  }

  // Off-path: not_signed — recoverable like learner 'lost'.
  if (currentStatus === "not_signed") {
    return (
      <div className="mt-4 space-y-3">
        <div className="text-sm text-rose-900 bg-rose-50 border border-rose-200 rounded-md p-3">
          Marked <strong>Not signed</strong>. If you ticked the wrong button or
          the employer has come back, you can still move them to one of these:
        </div>
        <div className="flex flex-wrap gap-2">
          {(["engaged", "in_progress", "signed"] as LeadStatus[]).map((s) => (
            <SecondaryButton
              key={s}
              label={STATUS_LABEL[s]}
              pending={pending && pendingValue === s}
              disabled={pending}
              onClick={() => fire(s)}
            />
          ))}
        </div>
        {error && <ErrorLine message={error} />}
      </div>
    );
  }

  const currentIndex = STEPPER_PATH.indexOf(currentStatus);
  const inAttemptPhase = ATTEMPT_STATES.has(currentStatus);

  return (
    <div className="mt-4 space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
          Move this lead forward
        </p>
        <div className="flex items-stretch gap-0">
          {STEPPER_PATH.map((step, idx) => {
            const isCurrent = idx === currentIndex;
            const isPast = idx < currentIndex;
            const isFuture = idx > currentIndex;
            const canClick = isFuture && isAllowedTransition(currentStatus, step, "employer_apprenticeship");
            const isPending = pending && pendingValue === step;
            return (
              <div key={step} className="flex-1 flex flex-col items-center min-w-0 relative">
                {idx < STEPPER_PATH.length - 1 && (
                  <div
                    className={`absolute top-4 left-1/2 right-0 h-0.5 ${
                      idx < currentIndex ? "bg-slate-900" : "bg-slate-200"
                    }`}
                    style={{ width: "100%" }}
                  />
                )}
                <button
                  type="button"
                  disabled={!canClick || pending}
                  onClick={() => canClick && fire(step)}
                  aria-label={`Mark ${STATUS_LABEL[step]}`}
                  className={`relative z-10 w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold border-2 transition-all ${
                    isCurrent
                      ? "bg-slate-900 border-slate-900 text-white"
                      : isPast
                        ? "bg-slate-300 border-slate-300 text-slate-500 cursor-not-allowed"
                        : canClick
                          ? "bg-white border-slate-300 text-slate-700 hover:border-slate-900 hover:text-slate-900 cursor-pointer"
                          : "bg-slate-100 border-slate-200 text-slate-300 cursor-not-allowed"
                  } ${isPending ? "animate-pulse" : ""}`}
                >
                  {isPast ? "✓" : idx + 1}
                </button>
                <span
                  className={`mt-2 text-[11px] text-center whitespace-nowrap ${
                    isCurrent ? "font-semibold text-slate-900" : "text-slate-500"
                  }`}
                >
                  {STEPPER_SHORT_LABEL[step]}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
          Or close out
        </p>
        <div className="flex flex-wrap gap-2">
          {inAttemptPhase && (
            <SecondaryButton
              label="Cannot reach…"
              pending={pending && pendingValue === "cannot_reach"}
              disabled={pending}
              onClick={() => setShowCloseout((v) => (v === "cannot_reach" ? null : "cannot_reach"))}
            />
          )}
          <SecondaryButton
            label="Mark not signed…"
            pending={pending && pendingValue === "not_signed"}
            disabled={pending}
            onClick={() => setShowCloseout((v) => (v === "not_signed" ? null : "not_signed"))}
          />
        </div>

        {showCloseout === "cannot_reach" && (
          <div className="mt-3 bg-amber-50 border border-amber-200 rounded-md p-3 space-y-2">
            <p className="text-xs text-amber-900">
              Use this when you&apos;ve made 3 attempts over the fortnight and the employer
              hasn&apos;t responded. Adds the lead to the closed list. You can still
              move it back into engagement if they come around.
            </p>
            <label className="block text-xs font-semibold text-amber-900 mt-2">
              Note (optional)
            </label>
            <textarea
              value={outcomeNote}
              onChange={(e) => setOutcomeNote(e.target.value.slice(0, OUTCOME_NOTE_MAX))}
              placeholder="Any context worth keeping…"
              rows={2}
              className="block w-full border border-amber-300 bg-white rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
            <p className="text-[11px] text-amber-700 text-right">
              {outcomeNote.length}/{OUTCOME_NOTE_MAX}
            </p>
            <button
              type="button"
              disabled={pending}
              onClick={() => fire("cannot_reach")}
              className="px-4 py-2 text-sm font-semibold bg-amber-600 text-white rounded-md hover:bg-amber-700 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              {pending && pendingValue === "cannot_reach" ? "Marking…" : "Confirm cannot reach"}
            </button>
          </div>
        )}

        {showCloseout === "not_signed" && (
          <div className="mt-3 bg-rose-50 border border-rose-200 rounded-md p-3 space-y-2">
            <label className="block text-xs font-semibold text-rose-900">Reason</label>
            <select
              value={notSignedReason}
              onChange={(e) => setNotSignedReason(e.target.value as NotSignedReason)}
              disabled={pending}
              className="block w-full border border-rose-300 bg-white rounded-md px-2 py-1.5 text-sm cursor-pointer disabled:cursor-not-allowed"
            >
              {VALID_NOT_SIGNED_REASONS.map((r) => (
                <option key={r} value={r}>{NOT_SIGNED_REASON_LABEL[r]}</option>
              ))}
            </select>
            <label className="block text-xs font-semibold text-rose-900 mt-3">
              Note (optional)
            </label>
            <textarea
              value={outcomeNote}
              onChange={(e) => setOutcomeNote(e.target.value.slice(0, OUTCOME_NOTE_MAX))}
              placeholder="Any context worth keeping…"
              rows={2}
              className="block w-full border border-rose-300 bg-white rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-rose-400"
            />
            <p className="text-[11px] text-rose-700 text-right">
              {outcomeNote.length}/{OUTCOME_NOTE_MAX}
            </p>
            <button
              type="button"
              disabled={pending}
              onClick={() => fire("not_signed", notSignedReason)}
              className="px-4 py-2 text-sm font-semibold bg-rose-600 text-white rounded-md hover:bg-rose-700 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              {pending && pendingValue === "not_signed" ? "Marking…" : "Confirm not signed"}
            </button>
          </div>
        )}
      </div>

      {error && <ErrorLine message={error} />}
    </div>
  );
}

function SecondaryButton({
  label,
  pending,
  disabled,
  onClick,
}: {
  label: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="px-3 py-1.5 text-sm font-semibold border border-slate-300 text-slate-800 bg-white rounded-md hover:bg-slate-50 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
    >
      {pending ? "Marking…" : label}
    </button>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2">
      {message}
    </div>
  );
}
