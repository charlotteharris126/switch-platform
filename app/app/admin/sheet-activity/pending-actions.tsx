"use client";

import { useState, useTransition } from "react";
import { resolvePendingUpdate } from "./actions";

const OVERRIDE_OPTIONS = [
  { value: "contacted", label: "Contacted" },
  { value: "enrolled", label: "Enrolled" },
  { value: "presumed_enrolled", label: "Presumed enrolled" },
  { value: "cannot_reach", label: "Cannot reach" },
  { value: "lost", label: "Lost" },
  { value: "not_enrolled", label: "Not enrolled" },
  { value: "disputed", label: "Disputed" },
];

export function PendingActions({
  pendingUpdateId,
  suggestedStatus,
}: {
  pendingUpdateId: number;
  suggestedStatus: string;
}) {
  const [pending, startTransition] = useTransition();
  const [resolved, setResolved] = useState<string | null>(null);
  const [showOverride, setShowOverride] = useState(false);

  function handle(action: "approve" | "reject" | "override", overrideStatus?: string) {
    startTransition(async () => {
      const result = await resolvePendingUpdate(pendingUpdateId, action, overrideStatus);
      setResolved(result.ok ? result.message : `Error: ${result.message}`);
    });
  }

  if (resolved) {
    return <span className="text-xs text-emerald-700 font-medium">{resolved}</span>;
  }

  if (showOverride) {
    return (
      <div className="flex flex-wrap gap-1 items-center">
        <span className="text-[10px] uppercase tracking-wide text-[#5a6a72] mr-1">Set to:</span>
        {OVERRIDE_OPTIONS.filter((o) => o.value !== suggestedStatus).map((o) => (
          <button
            key={o.value}
            onClick={() => handle("override", o.value)}
            disabled={pending}
            className="px-2 py-1 text-xs rounded border border-[#dad4cb] bg-white hover:bg-[#f4f1ed] disabled:opacity-50"
          >
            {o.label}
          </button>
        ))}
        <button
          onClick={() => setShowOverride(false)}
          disabled={pending}
          className="text-[10px] text-[#5a6a72] underline ml-1"
        >
          cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex gap-2 items-center">
      <button
        onClick={() => handle("approve")}
        disabled={pending}
        className="px-3 py-1 text-xs rounded bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-50"
      >
        Approve
      </button>
      <button
        onClick={() => handle("reject")}
        disabled={pending}
        className="px-3 py-1 text-xs rounded border border-[#dad4cb] bg-white hover:bg-[#f4f1ed] disabled:opacity-50"
      >
        Reject
      </button>
      <button
        onClick={() => setShowOverride(true)}
        disabled={pending}
        className="px-3 py-1 text-xs rounded border border-[#dad4cb] bg-white text-[#5a6a72] hover:bg-[#f4f1ed] disabled:opacity-50"
      >
        Choose different
      </button>
    </div>
  );
}
