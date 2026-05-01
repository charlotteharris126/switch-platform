"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { bulkMarkSourceResolved } from "./actions";

export function BulkResolveButton({
  source,
  count,
  defaultNote,
}: {
  source: string;
  count: number;
  defaultNote: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState(defaultNote);

  function handleResolve() {
    if (!note.trim()) {
      toast.warning("Add a note first.");
      return;
    }
    startTransition(async () => {
      const result = await bulkMarkSourceResolved(source, note.trim());
      if (result.ok) {
        toast.success(`Marked ${result.resolved ?? 0} rows resolved.`);
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
        className="text-xs px-3 py-1 rounded border border-[#dad4cb] bg-white hover:bg-[#f4f1ed] font-medium"
      >
        Mark all {count} resolved
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="text-xs px-2 py-1 border border-[#dad4cb] rounded bg-white min-w-[260px]"
        placeholder="Note (e.g. cleaned up — Brevo will catch up)"
      />
      <button
        type="button"
        onClick={handleResolve}
        disabled={pending}
        className="text-xs px-3 py-1 rounded bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-50 font-medium"
      >
        {pending ? "Resolving…" : `Confirm ${count}`}
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
