"use client";

import { useTransition, useState } from "react";

const OUTCOMES: Array<{ value: string; label: string; tone: string }> = [
  { value: "open", label: "Reset to open", tone: "slate" },
  { value: "attempt_1_no_answer", label: "1st no answer", tone: "amber" },
  { value: "attempt_2_no_answer", label: "2nd no answer", tone: "amber" },
  { value: "attempt_3_no_answer", label: "3rd no answer", tone: "orange" },
  { value: "enrolment_meeting_booked", label: "Meeting booked", tone: "blue" },
  { value: "enrolled", label: "Enrolled", tone: "emerald" },
  { value: "lost", label: "Lost", tone: "rose" },
  { value: "cannot_reach", label: "Cannot reach", tone: "rose" },
];

const TONE_STYLES: Record<string, string> = {
  slate: "border-slate-200 text-slate-700 hover:bg-slate-50",
  amber: "border-amber-200 text-amber-700 hover:bg-amber-50",
  orange: "border-orange-300 text-orange-700 hover:bg-orange-50",
  blue: "border-blue-200 text-blue-700 hover:bg-blue-50",
  emerald: "border-emerald-200 text-emerald-700 hover:bg-emerald-50",
  rose: "border-rose-200 text-rose-700 hover:bg-rose-50",
};

const ACTIVE_TONE: Record<string, string> = {
  slate: "bg-slate-100 border-slate-400 text-slate-900",
  amber: "bg-amber-100 border-amber-500 text-amber-900",
  orange: "bg-orange-100 border-orange-500 text-orange-900",
  blue: "bg-blue-100 border-blue-500 text-blue-900",
  emerald: "bg-emerald-100 border-emerald-500 text-emerald-900",
  rose: "bg-rose-100 border-rose-500 text-rose-900",
};

interface Props {
  submissionId: number;
  currentStatus: string;
  onMark: (args: { submissionId: number; status: string; lostReason?: string | null }) => Promise<{ ok: boolean; error?: string }>;
}

export function OutcomeButtons({ submissionId, currentStatus, onMark }: Props) {
  const [pending, startTransition] = useTransition();
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLost, setShowLost] = useState(false);
  const [lostReason, setLostReason] = useState<string>("not_interested");

  function fire(value: string) {
    setError(null);
    setPendingValue(value);
    startTransition(async () => {
      const result = await onMark({
        submissionId,
        status: value,
        lostReason: value === "lost" ? lostReason : null,
      });
      if (!result.ok) setError(result.error ?? "Failed to update");
      setPendingValue(null);
      if (value === "lost") setShowLost(false);
    });
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap gap-2">
        {OUTCOMES.map((o) => {
          const isActive = currentStatus === o.value;
          const isPending = pending && pendingValue === o.value;
          const cls = isActive ? ACTIVE_TONE[o.tone] : TONE_STYLES[o.tone];
          return (
            <button
              key={o.value}
              type="button"
              disabled={pending || (isActive && o.value !== "open")}
              onClick={() => {
                if (o.value === "lost") {
                  setShowLost((v) => !v);
                  return;
                }
                fire(o.value);
              }}
              className={`px-3 py-1.5 rounded-md text-sm font-medium border ${cls} disabled:opacity-60 disabled:cursor-not-allowed transition-colors`}
            >
              {isPending ? "…" : o.label}
              {isActive && o.value !== "open" && <span className="ml-1 text-xs">(current)</span>}
            </button>
          );
        })}
      </div>

      {showLost && (
        <div className="mt-3 p-3 bg-rose-50 border border-rose-200 rounded-md">
          <label className="block text-xs font-semibold text-rose-900 uppercase tracking-wide">Why was this lost?</label>
          <select
            value={lostReason}
            onChange={(e) => setLostReason(e.target.value)}
            className="mt-1 w-full border border-rose-300 rounded-md px-2 py-1.5 text-sm bg-white"
          >
            <option value="not_interested">Not interested</option>
            <option value="wrong_course">Wrong course</option>
            <option value="funding_issue">Funding issue</option>
            <option value="cancelled">Cancelled</option>
            <option value="withdrew_after_enrolment">Withdrew after enrolment</option>
            <option value="other">Other</option>
          </select>
          <button
            type="button"
            onClick={() => fire("lost")}
            disabled={pending}
            className="mt-2 px-3 py-1.5 bg-rose-600 text-white rounded-md text-sm font-semibold hover:bg-rose-700 disabled:opacity-60"
          >
            {pending && pendingValue === "lost" ? "Marking lost…" : "Mark lost"}
          </button>
        </div>
      )}

      {error && (
        <div className="mt-3 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2">
          {error}
        </div>
      )}
    </div>
  );
}
