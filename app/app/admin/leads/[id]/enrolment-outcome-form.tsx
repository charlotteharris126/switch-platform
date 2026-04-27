"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { markEnrolmentOutcome, type EnrolmentStatus, type LostReason } from "./actions";

interface Props {
  submissionId: number;
  currentStatus: string | null;
  currentNotes: string | null;
  currentLostReason: string | null;
  currentDisputedAt: string | null;
  currentDisputedReason: string | null;
  isRouted: boolean;
}

const STATUSES: Array<{ value: EnrolmentStatus; label: string; description: string }> = [
  { value: "open",              label: "Open",              description: "No outcome yet. Provider hasn't confirmed contact." },
  { value: "enrolled",          label: "Enrolled",          description: "Learner started the course. Counts toward billing." },
  { value: "presumed_enrolled", label: "Presumed enrolled", description: "Provider hasn't confirmed after 14 days. Auto-set by cron normally." },
  { value: "cannot_reach",      label: "Cannot reach",      description: "Provider tried to contact but no response after multiple attempts." },
  { value: "lost",              label: "Lost",              description: "Provider made contact but learner won't enrol. Pick a reason." },
];

const LOST_REASONS: Array<{ value: LostReason; label: string }> = [
  { value: "not_interested", label: "Not interested" },
  { value: "wrong_course",   label: "Wrong course" },
  { value: "funding_issue",  label: "Funding issue" },
  { value: "other",          label: "Other" },
];

export function EnrolmentOutcomeForm({
  submissionId,
  currentStatus,
  currentNotes,
  currentLostReason,
  currentDisputedAt,
  currentDisputedReason,
  isRouted,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [displayStatus, setDisplayStatus] = useState<string | null>(currentStatus);
  const [selectedStatus, setSelectedStatus] = useState<EnrolmentStatus | null>(
    isStatus(currentStatus) ? currentStatus : null,
  );
  const [selectedReason, setSelectedReason] = useState<LostReason | null>(
    isLostReason(currentLostReason) ? currentLostReason : null,
  );
  const [notes, setNotes] = useState(currentNotes ?? "");
  const [disputed, setDisputed] = useState(Boolean(currentDisputedAt));
  const [disputedReason, setDisputedReason] = useState(currentDisputedReason ?? "");

  if (!isRouted) {
    return (
      <div className="bg-white border border-[#dad4cb] rounded-xl p-4 shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
        <h3 className="text-sm font-extrabold text-[#11242e] mb-1">Enrolment outcome</h3>
        <p className="text-xs text-[#5a6a72]">Lead must be routed to a provider before an outcome can be recorded.</p>
      </div>
    );
  }

  const showLostReason = selectedStatus === "lost";
  const showDisputeBlock = selectedStatus === "presumed_enrolled";

  function handleSubmit() {
    if (!selectedStatus) {
      toast.warning("Pick a status before saving.");
      return;
    }
    if (selectedStatus === "lost" && !selectedReason) {
      toast.warning("Pick a reason for Lost before saving.");
      return;
    }
    if (disputed && (!disputedReason || disputedReason.trim().length === 0)) {
      toast.warning("Add a dispute reason before saving.");
      return;
    }

    const previousDisplay = displayStatus;
    setDisplayStatus(selectedStatus);

    startTransition(async () => {
      const result = await markEnrolmentOutcome({
        submissionId,
        status:         selectedStatus,
        notes:          notes.trim() || null,
        lostReason:     selectedStatus === "lost" ? selectedReason : null,
        disputed:       selectedStatus === "presumed_enrolled" ? disputed : false,
        disputedReason: selectedStatus === "presumed_enrolled" && disputed ? disputedReason.trim() || null : null,
      });
      if (result.ok) {
        toast.success("Outcome saved", {
          description: `Marked as ${selectedStatus.replace(/_/g, " ")}.`,
        });
      } else {
        setDisplayStatus(previousDisplay);
        toast.error("Save failed", { description: result.error ?? "Unknown error." });
      }
    });
  }

  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-4 shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
      <h3 className="text-sm font-extrabold text-[#11242e] mb-1">Enrolment outcome</h3>
      {displayStatus && (
        <p className="text-[11px] text-[#5a6a72] mb-3">
          Currently: <span className="font-bold uppercase tracking-wide text-[#143643]">{displayStatus.replace(/_/g, " ")}</span>
          {currentDisputedAt && (
            <> · <span className="font-bold uppercase tracking-wide text-[#cd8b76]">disputed</span></>
          )}
        </p>
      )}

      {/* Status buttons */}
      <div className="flex flex-wrap gap-2 mb-3">
        {STATUSES.map((s) => {
          const selected = selectedStatus === s.value;
          return (
            <button
              key={s.value}
              type="button"
              onClick={() => setSelectedStatus(s.value)}
              disabled={pending}
              title={s.description}
              className={
                "px-4 h-9 text-xs font-bold uppercase tracking-[0.08em] rounded-full border transition-all duration-150 active:scale-[0.97] " +
                (selected
                  ? "bg-[#cd8b76] text-white border-[#cd8b76] shadow-[0_2px_6px_rgba(205,139,118,0.35)]"
                  : "bg-white text-[#143643] border-[#dad4cb] hover:border-[#cd8b76]/60 hover:bg-[#fbf9f5] hover:-translate-y-px")
              }
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {/* Conditional: lost reason radio appears when status=Lost */}
      {showLostReason && (
        <div className="mb-3 pl-3 border-l-2 border-[#cd8b76]">
          <p className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72] mb-2">Why was it lost?</p>
          <div className="flex flex-wrap gap-2">
            {LOST_REASONS.map((r) => {
              const selected = selectedReason === r.value;
              return (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => setSelectedReason(r.value)}
                  disabled={pending}
                  className={
                    "px-3 h-8 text-[11px] font-bold uppercase tracking-[0.06em] rounded-full border transition-all duration-150 active:scale-[0.97] " +
                    (selected
                      ? "bg-[#143643] text-white border-[#143643]"
                      : "bg-white text-[#143643] border-[#dad4cb] hover:border-[#143643]/60")
                  }
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Conditional: dispute flag appears when status=Presumed enrolled */}
      {showDisputeBlock && (
        <div className="mb-3 pl-3 border-l-2 border-[#143643]">
          <label className="flex items-center gap-2 mb-2">
            <input
              type="checkbox"
              checked={disputed}
              onChange={(e) => setDisputed(e.target.checked)}
              disabled={pending}
              className="h-4 w-4 accent-[#cd8b76]"
            />
            <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#11242e]">Provider disputes this</span>
          </label>
          {disputed && (
            <textarea
              value={disputedReason}
              onChange={(e) => setDisputedReason(e.target.value)}
              placeholder="What is the provider's reason for the dispute?"
              rows={2}
              disabled={pending}
              className="w-full text-xs border border-[#dad4cb] rounded-lg bg-white px-3 py-2 text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76] resize-y"
            />
          )}
        </div>
      )}

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
          disabled={pending || !selectedStatus}
          className="h-9 px-5 text-[11px] font-bold uppercase tracking-[0.08em] rounded-full bg-[#143643] text-white hover:bg-[#11242e] active:scale-[0.97] transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[#143643] shadow-[0_2px_6px_rgba(17,36,46,0.15)]"
        >
          {pending ? "Saving..." : "Save outcome"}
        </button>
      </div>
    </div>
  );
}

function isStatus(value: string | null): value is EnrolmentStatus {
  return value === "open" || value === "enrolled" || value === "presumed_enrolled" || value === "cannot_reach" || value === "lost";
}

function isLostReason(value: string | null): value is LostReason {
  return value === "not_interested" || value === "wrong_course" || value === "funding_issue" || value === "other";
}
