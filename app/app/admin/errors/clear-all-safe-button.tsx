"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { bulkResolveSafeSources } from "./actions";

// One-click clear for everything the page has classified clean/info severity.
// The page passes the exact safe-source list; this component never decides
// what's safe. Two-step confirm so it can't be fat-fingered.
export function ClearAllSafeButton({
  sources,
  count,
}: {
  sources: string[];
  count: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  if (count === 0) return null;

  function handleClear() {
    startTransition(async () => {
      const result = await bulkResolveSafeSources(sources);
      if (result.ok) {
        toast.success(`Cleared ${result.resolved ?? 0} safe rows.`);
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
        className="text-sm px-4 py-2 rounded-md bg-emerald-700 text-white hover:bg-emerald-800 font-semibold"
      >
        Clear all {count} safe rows
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-[#11242e]">Clear {count} rows that need no action?</span>
      <button
        type="button"
        onClick={handleClear}
        disabled={pending}
        className="text-sm px-4 py-2 rounded-md bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-50 font-semibold"
      >
        {pending ? "Clearing…" : `Yes, clear ${count}`}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={pending}
        className="text-sm text-[#5a6a72] underline"
      >
        cancel
      </button>
    </div>
  );
}
