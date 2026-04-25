"use client";

import { useState, useTransition } from "react";
import { markEnrolmentOutcome, type EnrolmentOutcome } from "./actions";

interface Props {
  submissionId: number;
  currentStatus: string | null;
  currentNotes: string | null;
  isRouted: boolean;
}

const OUTCOMES: Array<{ value: EnrolmentOutcome; label: string; description: string }> = [
  { value: "enrolled", label: "Enrolled", description: "Learner started the course. Counts toward billing." },
  { value: "not_enrolled", label: "Not enrolled", description: "Confirmed didn't start (dropped out, no-show, changed mind)." },
  { value: "presumed_enrolled", label: "Presumed enrolled", description: "Provider hasn't confirmed either way after 14 days. Auto-set by cron normally." },
  { value: "disputed", label: "Disputed", description: "Provider disputes the presumed-enrolled flip." },
];

export function EnrolmentOutcomeForm({ submissionId, currentStatus, currentNotes, isRouted }: Props) {
  const [pending, startTransition] = useTransition();
  const [selectedOutcome, setSelectedOutcome] = useState<EnrolmentOutcome | null>(
    isOutcome(currentStatus) ? currentStatus : null,
  );
  const [notes, setNotes] = useState(currentNotes ?? "");
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  if (!isRouted) {
    return (
      <div className="bg-white border border-[#dad4cb] rounded-xl p-4 shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
        <h3 className="text-sm font-extrabold text-[#11242e] mb-1">Enrolment outcome</h3>
        <p className="text-xs text-[#5a6a72]">Lead must be routed to a provider before an outcome can be recorded.</p>
      </div>
    );
  }

  function handleSubmit() {
    if (!selectedOutcome) {
      setFeedback({ kind: "error", message: "Pick an outcome before saving." });
      return;
    }
    setFeedback(null);
    startTransition(async () => {
      const result = await markEnrolmentOutcome({
        submissionId,
        outcome: selectedOutcome,
        notes: notes.trim() || null,
      });
      if (result.ok) {
        setFeedback({ kind: "success", message: `Saved. Enrolment id ${result.enrolmentId}.` });
      } else {
        setFeedback({ kind: "error", message: result.error ?? "Save failed." });
      }
    });
  }

  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-4 shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
      <h3 className="text-sm font-extrabold text-[#11242e] mb-1">Enrolment outcome</h3>
      {currentStatus && (
        <p className="text-[11px] text-[#5a6a72] mb-3">
          Currently: <span className="font-bold uppercase tracking-wide text-[#143643]">{currentStatus.replace(/_/g, " ")}</span>
        </p>
      )}

      <div className="flex flex-wrap gap-2 mb-3">
        {OUTCOMES.map((o) => {
          const selected = selectedOutcome === o.value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => setSelectedOutcome(o.value)}
              disabled={pending}
              title={o.description}
              className={
                selected
                  ? "px-4 h-9 text-xs font-bold uppercase tracking-[0.08em] rounded-full bg-[#cd8b76] text-white border border-[#cd8b76] shadow-[0_1px_2px_rgba(17,36,46,0.08)]"
                  : "px-4 h-9 text-xs font-bold uppercase tracking-[0.08em] rounded-full bg-white text-[#143643] border border-[#dad4cb] hover:border-[#cd8b76]/60"
              }
            >
              {o.label}
            </button>
          );
        })}
      </div>

      <label className="flex flex-col gap-1 mb-3">
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Notes (optional)</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. spoke to provider, didn't show up to session 1"
          rows={2}
          disabled={pending}
          className="text-xs border border-[#dad4cb] rounded-lg bg-white px-3 py-2 text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76] resize-y"
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={pending || !selectedOutcome}
          className="h-9 px-5 text-[11px] font-bold uppercase tracking-[0.08em] rounded-full bg-[#143643] text-white hover:bg-[#11242e] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {pending ? "Saving..." : "Save outcome"}
        </button>
        {feedback && (
          <span className={feedback.kind === "success" ? "text-xs text-emerald-700" : "text-xs text-[#b3412e]"}>
            {feedback.message}
          </span>
        )}
      </div>
    </div>
  );
}

function isOutcome(value: string | null): value is EnrolmentOutcome {
  return value === "enrolled" || value === "not_enrolled" || value === "presumed_enrolled" || value === "disputed";
}
