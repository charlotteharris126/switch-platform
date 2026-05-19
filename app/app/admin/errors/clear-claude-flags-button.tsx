"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { bulkClearClaudeFlags } from "./actions";

// Clears every row in the Flagged-for-Claude panel by appending a
// "claude flag cleared" marker to error_context. Audit trail stays
// intact — original error_context (incl. "Flagged for next session"
// note) is preserved verbatim. The panel filter then excludes the
// cleared rows.
export function ClearClaudeFlagsButton({ count }: { count: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  function handleClear() {
    startTransition(async () => {
      const result = await bulkClearClaudeFlags();
      if (result.ok) {
        toast.success(`Cleared ${result.cleared ?? 0} rows from Claude queue.`);
        setConfirming(false);
        router.refresh();
      } else {
        toast.error("Failed", { description: result.error });
      }
    });
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-xs px-3 py-1 rounded border border-amber-300 bg-white hover:bg-amber-100 font-medium text-amber-900"
      >
        Clear all {count}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-amber-900">Removes from the Claude queue, keeps the audit row.</span>
      <button
        type="button"
        onClick={handleClear}
        disabled={pending}
        className="text-xs px-3 py-1 rounded bg-amber-700 text-white hover:bg-amber-800 disabled:opacity-50 font-medium"
      >
        {pending ? "Clearing…" : `Confirm clear ${count}`}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={pending}
        className="text-xs text-[#5a6a72] underline"
      >
        cancel
      </button>
    </div>
  );
}
