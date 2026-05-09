"use client";

import { useTransition, useState } from "react";
import {
  allowedNextStatuses,
  lostReasonsFor,
  STATUS_LABEL,
  type LeadStatus,
  type LostReason,
} from "@/lib/lead-status";

const TONE: Record<LeadStatus, string> = {
  open: "border-slate-200 text-slate-700 hover:bg-slate-50",
  attempt_1_no_answer: "border-amber-200 text-amber-800 hover:bg-amber-50",
  attempt_2_no_answer: "border-amber-300 text-amber-800 hover:bg-amber-100",
  attempt_3_no_answer: "border-orange-300 text-orange-800 hover:bg-orange-50",
  enrolment_meeting_booked: "border-blue-200 text-blue-700 hover:bg-blue-50",
  enrolled: "border-emerald-200 text-emerald-700 hover:bg-emerald-50",
  lost: "border-rose-200 text-rose-700 hover:bg-rose-50",
  cannot_reach: "border-rose-200 text-rose-700 hover:bg-rose-50",
  presumed_enrolled: "border-emerald-200 text-emerald-700",
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
  }) => Promise<{ ok: boolean; error?: string }>;
}

export function OutcomeButtons({ submissionId, currentStatus, onMark }: Props) {
  const [pending, startTransition] = useTransition();
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLost, setShowLost] = useState(false);
  const [lostReason, setLostReason] = useState<LostReason>(
    lostReasonsFor(currentStatus)[0] ?? "other",
  );

  const nextStatuses = allowedNextStatuses(currentStatus);
  const lostReasons = lostReasonsFor(currentStatus);

  function fire(value: LeadStatus, reason?: LostReason) {
    setError(null);
    setPendingValue(value);
    startTransition(async () => {
      const result = await onMark({
        submissionId,
        status: value,
        lostReason: value === "lost" ? reason ?? null : null,
      });
      if (!result.ok) setError(result.error ?? "Failed to update");
      setPendingValue(null);
      if (value === "lost") setShowLost(false);
    });
  }

  if (nextStatuses.length === 0) {
    return (
      <div className="mt-4 text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-md p-3">
        This lead is settled at <strong>{STATUS_LABEL[currentStatus]}</strong>. No
        further outcomes can be set from the portal. If something needs unwinding,
        message Charlotte.
      </div>
    );
  }

  // Group: progression statuses (attempts + meeting + enrolled) vs terminal-ish (lost / cannot_reach)
  const progressKeys: LeadStatus[] = [
    "attempt_1_no_answer",
    "attempt_2_no_answer",
    "attempt_3_no_answer",
    "enrolment_meeting_booked",
    "enrolled",
  ];
  const progressNext = nextStatuses.filter((s) => progressKeys.includes(s));
  const closeoutNext = nextStatuses.filter((s) => s === "lost" || s === "cannot_reach");

  return (
    <div className="mt-4 space-y-4">
      {progressNext.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
            Move forward
          </p>
          <div className="flex flex-wrap gap-2">
            {progressNext.map((s) => {
              const isPending = pending && pendingValue === s;
              return (
                <button
                  key={s}
                  type="button"
                  disabled={pending}
                  onClick={() => fire(s)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium border bg-white ${TONE[s]} disabled:opacity-60 disabled:cursor-not-allowed transition-colors`}
                >
                  {isPending ? "…" : STATUS_LABEL[s]}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {closeoutNext.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
            Close out
          </p>
          <div className="flex flex-wrap gap-2">
            {closeoutNext.map((s) => {
              const isPending = pending && pendingValue === s;
              return (
                <button
                  key={s}
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (s === "lost") {
                      setShowLost((v) => !v);
                      return;
                    }
                    fire(s);
                  }}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium border bg-white ${TONE[s]} disabled:opacity-60 disabled:cursor-not-allowed transition-colors`}
                >
                  {isPending ? "…" : STATUS_LABEL[s]}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {showLost && (
        <div className="p-3 bg-rose-50 border border-rose-200 rounded-md">
          <label className="block text-xs font-semibold text-rose-900 uppercase tracking-wide">
            Why was this lost?
          </label>
          <select
            value={lostReason}
            onChange={(e) => setLostReason(e.target.value as LostReason)}
            className="mt-1 w-full border border-rose-300 rounded-md px-2 py-1.5 text-sm bg-white"
          >
            {lostReasons.map((r) => (
              <option key={r} value={r}>
                {LOST_REASON_LABEL[r]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => fire("lost", lostReason)}
            disabled={pending}
            className="mt-2 px-3 py-1.5 bg-rose-600 text-white rounded-md text-sm font-semibold hover:bg-rose-700 disabled:opacity-60"
          >
            {pending && pendingValue === "lost" ? "Marking lost…" : "Mark lost"}
          </button>
        </div>
      )}

      {error && (
        <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2">
          {error}
        </div>
      )}
    </div>
  );
}
