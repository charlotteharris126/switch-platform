"use client";

import { useTransition, useState } from "react";
import {
  isAllowedTransition,
  lostReasonsFor,
  STATUS_LABEL,
  type LeadStatus,
  type LostReason,
} from "@/lib/lead-status";

// Main happy-path progression. Click any unfilled step to advance.
// Stepper hides closeout statuses (lost, cannot_reach). those sit as
// secondary actions below the line.
const STEPPER_PATH: ReadonlyArray<LeadStatus> = [
  "open",
  "attempt_1_no_answer",
  "attempt_2_no_answer",
  "attempt_3_no_answer",
  "enrolment_meeting_booked",
  "enrolled",
];

const STEPPER_SHORT_LABEL: Record<LeadStatus, string> = {
  open: "Open",
  attempt_1_no_answer: "1st",
  attempt_2_no_answer: "2nd",
  attempt_3_no_answer: "3rd",
  enrolment_meeting_booked: "Meeting",
  enrolled: "Enrolled",
  lost: "Lost",
  cannot_reach: "Cannot reach",
  presumed_enrolled: "Presumed",
  // Employer-lead stepper labels. Currently unused (employer outcome
  // buttons render a different layout — see EmployerOutcomeButtons) but
  // kept here so the Record stays exhaustive across LeadStatus values.
  engaged: "Engaged",
  in_progress: "In progress",
  signed: "Signed",
  not_signed: "Not signed",
  presumed_employer_signed: "Presumed",
};

const LOST_REASON_LABEL: Record<LostReason, string> = {
  not_interested: "Not interested",
  wrong_course: "Wrong course",
  funding_issue: "Funding issue",
  cancelled: "Cancelled",
  withdrew_after_enrolment: "Withdrew after enrolment",
  l3_mismatch_self_reported: "L3 mismatch (self-reported)",
  cohort_decline: "Couldn't make the cohort dates",
  other: "Other",
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

export function OutcomeButtons({ submissionId, currentStatus, onMark }: Props) {
  const [pending, startTransition] = useTransition();
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lostReason, setLostReason] = useState<LostReason>(
    lostReasonsFor(currentStatus)[0] ?? "other",
  );
  // Closeout picker state: which terminal status is being collected
  // (lost / cannot_reach), and the free-text note that goes with it.
  const [showCloseout, setShowCloseout] = useState<"lost" | "cannot_reach" | null>(null);
  const [outcomeNote, setOutcomeNote] = useState("");


  const lostReasons = lostReasonsFor(currentStatus);
  const isOnPath = STEPPER_PATH.includes(currentStatus);
  const isClosedOut = currentStatus === "presumed_enrolled";

  function fire(value: LeadStatus, reason?: LostReason) {
    setError(null);
    setPendingValue(value);
    const noteToSend = value === "lost" || value === "cannot_reach"
      ? outcomeNote.trim() || null
      : null;
    startTransition(async () => {
      const result = await onMark({
        submissionId,
        status: value,
        lostReason: value === "lost" ? reason ?? null : null,
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

  // Lock-out states (terminal, no further moves possible)
  if (isClosedOut) {
    return (
      <div className="mt-4 text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-md p-3">
        This lead is settled at <strong>{STATUS_LABEL[currentStatus]}</strong>.
        No further outcomes can be set from the portal. Email support@switchleads.co.uk if
        anything needs unwinding.
      </div>
    );
  }

  // Off-path current state (cannot_reach). render mini message + close-out only
  if (!isOnPath && currentStatus === "cannot_reach") {
    return (
      <div className="mt-4 space-y-3">
        <div className="text-sm text-slate-600 bg-amber-50 border border-amber-200 rounded-md p-3">
          Marked <strong>Cannot reach</strong>. If the learner re-engages you can
          still move them to <em>Meeting booked</em> or <em>Enrolled</em>.
        </div>
        <div className="flex flex-wrap gap-2">
          {(["enrolment_meeting_booked", "enrolled"] as LeadStatus[]).map((s) => (
            <PrimaryButton
              key={s}
              label={STATUS_LABEL[s]}
              pending={pending && pendingValue === s}
              disabled={pending}
              onClick={() => fire(s)}
              tone="ok"
            />
          ))}
          <SecondaryButton
            label="Mark lost…"
            pending={pending && pendingValue === "lost"}
            disabled={pending}
            onClick={() => setShowCloseout((v) => v === "lost" ? null : "lost")}
            tone="rose"
          />
        </div>
        {renderClosePicker()}
        {error && renderError()}
      </div>
    );
  }

  // Off-path: lost. Provider can correct a mis-click or re-open if the
  // learner re-engaged and verified things.
  if (currentStatus === "lost") {
    return (
      <div className="mt-4 space-y-3">
        <div className="text-sm text-rose-900 bg-rose-50 border border-rose-200 rounded-md p-3">
          Marked <strong>Lost</strong>. If you ticked the wrong button or the
          learner has come back and verified things, you can still move them to
          one of these:
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
            Move them to
          </p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["enrolled", "emerald"],
                ["enrolment_meeting_booked", "blue"],
                ["cannot_reach", "amber"],
                ["attempt_1_no_answer", "rose"],
                ["attempt_2_no_answer", "rose"],
                ["attempt_3_no_answer", "rose"],
              ] as Array<[LeadStatus, "emerald" | "blue" | "amber" | "rose"]>
            ).map(([s, tone]) => (
              <SecondaryButton
                key={s}
                label={STATUS_LABEL[s]}
                pending={pending && pendingValue === s}
                disabled={pending}
                onClick={() => fire(s)}
                tone={tone}
              />
            ))}
          </div>
        </div>
        {error && renderError()}
      </div>
    );
  }

  // Stepper-rendered statuses (open + attempt 1/2/3 + meeting + enrolled)
  const currentIndex = STEPPER_PATH.indexOf(currentStatus);

  return (
    <div className="mt-4 space-y-5">
      {/* Stepper */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
          Move this lead forward
        </p>
        <div className="flex items-stretch gap-0">
          {STEPPER_PATH.map((step, idx) => {
            const isCurrent = idx === currentIndex;
            const isPast = idx < currentIndex;
            const isFuture = idx > currentIndex;
            const canClick = isFuture && isAllowedTransition(currentStatus, step);
            const isPending = pending && pendingValue === step;
            return (
              <div key={step} className="flex-1 flex flex-col items-center min-w-0 relative">
                {/* Connector to next step */}
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
                          ? "bg-white border-slate-300 text-slate-500 hover:border-slate-900 hover:text-slate-900 hover:scale-110 cursor-pointer"
                          : "bg-white border-slate-200 text-slate-300 cursor-not-allowed"
                  }`}
                >
                  {isPending ? (
                    <span className="animate-pulse">…</span>
                  ) : isPast ? (
                    "✓"
                  ) : (
                    idx + 1
                  )}
                </button>
                <span
                  className={`mt-2 text-xs text-center px-1 leading-tight ${
                    isCurrent
                      ? "text-slate-900 font-semibold"
                      : isPast
                        ? "text-slate-400"
                        : canClick
                          ? "text-slate-700"
                          : "text-slate-300"
                  }`}
                >
                  {STEPPER_SHORT_LABEL[step]}
                </span>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-slate-500 mt-3">
          Click a future step to mark it. Past steps are locked. Email support@switchleads.co.uk if
          something needs unwinding.
        </p>
      </div>

      {/* Closeouts. secondary actions */}
      <div className="border-t border-slate-100 pt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
          Or close this out
        </p>
        <div className="flex flex-wrap gap-2">
          {isAllowedTransition(currentStatus, "cannot_reach") && (
            <SecondaryButton
              label="Cannot reach…"
              pending={pending && pendingValue === "cannot_reach"}
              disabled={pending}
              onClick={() => setShowCloseout((v) => v === "cannot_reach" ? null : "cannot_reach")}
              tone="amber"
            />
          )}
          {isAllowedTransition(currentStatus, "lost") && (
            <SecondaryButton
              label="Mark lost…"
              pending={pending && pendingValue === "lost"}
              disabled={pending}
              onClick={() => setShowCloseout((v) => v === "lost" ? null : "lost")}
              tone="rose"
            />
          )}
        </div>
      </div>

      {renderClosePicker()}
      {error && renderError()}
    </div>
  );

  function renderClosePicker() {
    if (showCloseout === "lost") return renderLostPicker();
    if (showCloseout === "cannot_reach") return renderCannotReachPicker();
    return null;
  }

  function renderLostPicker() {
    return (
      <div className="p-3 bg-rose-50 border border-rose-200 rounded-md space-y-2">
        <label className="block text-xs font-semibold text-rose-900 uppercase tracking-wide">
          Why was this lost?
        </label>
        <select
          value={lostReason}
          onChange={(e) => setLostReason(e.target.value as LostReason)}
          className="w-full border border-rose-300 rounded-md px-2 py-1.5 text-sm bg-white cursor-pointer"
        >
          {lostReasons.map((r) => (
            <option key={r} value={r}>
              {LOST_REASON_LABEL[r]}
            </option>
          ))}
        </select>
        {renderOutcomeNoteField("rose")}
        <button
          type="button"
          onClick={() => fire("lost", lostReason)}
          disabled={pending}
          className="px-3 py-1.5 bg-rose-600 text-white rounded-md text-sm font-semibold hover:bg-rose-700 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          {pending && pendingValue === "lost" ? "Marking lost…" : "Mark lost"}
        </button>
      </div>
    );
  }

  function renderCannotReachPicker() {
    return (
      <div className="p-3 bg-amber-50 border border-amber-200 rounded-md space-y-2">
        <p className="text-xs font-semibold text-amber-900 uppercase tracking-wide">
          Mark cannot reach
        </p>
        <p className="text-xs text-amber-800">
          Used after several unanswered attempts. If the learner re-engages you can still move them on.
        </p>
        {renderOutcomeNoteField("amber")}
        <button
          type="button"
          onClick={() => fire("cannot_reach")}
          disabled={pending}
          className="px-3 py-1.5 bg-amber-600 text-white rounded-md text-sm font-semibold hover:bg-amber-700 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          {pending && pendingValue === "cannot_reach" ? "Marking cannot reach…" : "Confirm cannot reach"}
        </button>
      </div>
    );
  }

  function renderOutcomeNoteField(tone: "rose" | "amber") {
    const accent = tone === "rose"
      ? "text-rose-900 border-rose-300"
      : "text-amber-900 border-amber-300";
    return (
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide opacity-75">
          Note (optional)
        </label>
        <textarea
          value={outcomeNote}
          onChange={(e) => setOutcomeNote(e.target.value.slice(0, OUTCOME_NOTE_MAX))}
          placeholder="Anything specific worth recording? e.g. asked us to try again next month, moved house, switched provider mid-call."
          rows={2}
          maxLength={OUTCOME_NOTE_MAX}
          className={`w-full border rounded-md px-2 py-1.5 text-sm bg-white ${accent}`}
        />
        <p className="text-[10px] text-slate-500 mt-1 text-right tabular-nums">
          {outcomeNote.length} / {OUTCOME_NOTE_MAX}
        </p>
      </div>
    );
  }

  function renderError() {
    return (
      <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2">
        {error}
      </div>
    );
  }
}

function PrimaryButton({
  label,
  pending,
  disabled,
  onClick,
  tone,
}: {
  label: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
  tone: "ok";
}) {
  void tone;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="px-4 py-2 rounded-md text-sm font-semibold border bg-slate-900 text-white border-slate-900 hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
    >
      {pending ? "…" : label}
    </button>
  );
}

function SecondaryButton({
  label,
  pending,
  disabled,
  onClick,
  tone,
}: {
  label: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
  tone: "amber" | "rose" | "emerald" | "blue";
}) {
  const toneMap: Record<string, string> = {
    amber: "border-amber-300 text-amber-800 bg-white hover:bg-amber-50",
    rose: "border-rose-300 text-rose-700 bg-white hover:bg-rose-50",
    emerald: "border-emerald-300 text-emerald-800 bg-white hover:bg-emerald-50",
    blue: "border-blue-300 text-blue-800 bg-white hover:bg-blue-50",
  };
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md text-sm font-medium border ${toneMap[tone]} disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors`}
    >
      {pending ? "…" : label}
    </button>
  );
}
