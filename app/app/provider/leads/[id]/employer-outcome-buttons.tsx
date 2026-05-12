"use client";

// Employer-lead outcome buttons. Parallel to <OutcomeButtons> (which is
// learner-shaped) — chosen by LeadDetailView based on submission.lead_type.
//
// Workflow is shorter than learner: no call-attempt counter, no fastrack.
//   open → engaged (first meeting) → in_progress (deal warm) → signed
//                                                 ↓
//                                              not_signed (recoverable)
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

const STEPPER_PATH: ReadonlyArray<LeadStatus> = ["open", "engaged", "in_progress", "signed"];

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

export function EmployerOutcomeButtons({ submissionId, currentStatus, onMark }: Props) {
  const [pending, startTransition] = useTransition();
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCloseout, setShowCloseout] = useState<boolean>(false);
  const [notSignedReason, setNotSignedReason] = useState<NotSignedReason>("decided_not_to_proceed");
  const [outcomeNote, setOutcomeNote] = useState("");

  const isClosedOut = currentStatus === "presumed_employer_signed";

  function fire(value: LeadStatus, reason?: NotSignedReason) {
    setError(null);
    setPendingValue(value);
    const noteToSend = value === "not_signed" ? outcomeNote.trim() || null : null;
    startTransition(async () => {
      const result = await onMark({
        submissionId,
        status: value,
        // not_signed reuses the lost_reason column for storage (the schema
        // doesn't differentiate; the column name is historical). Reason
        // value comes from VALID_NOT_SIGNED_REASONS so analytics can split
        // employer vs learner by lead_type at query time.
        lostReason: value === "not_signed" ? reason ?? null : null,
        outcomeNote: noteToSend,
      });
      if (!result.ok) setError(result.error ?? "Failed to update");
      setPendingValue(null);
      if (result.ok) {
        setOutcomeNote("");
        setShowCloseout(false);
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
                  {STATUS_LABEL[step]}
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
        <SecondaryButton
          label="Mark not signed…"
          pending={pending && pendingValue === "not_signed"}
          disabled={pending}
          onClick={() => setShowCloseout((v) => !v)}
        />

        {showCloseout && (
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
