"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { bulkMarkSourceResolved } from "./actions";

export function BulkResolveButton({
  source,
  count,
  defaultNote,
  isFlag = false,
}: {
  source: string;
  count: number;
  defaultNote: string;
  // isFlag = true reframes as "Flag all N for Claude" and prefixes the
  // saved note with "Flagged for next session" so it's greppable in the
  // audit trail. Used on fix-severity cards where rows aren't owner-
  // fixable but can be cleared as a batch (e.g. all caused by the same
  // root issue that's now been migrated away).
  isFlag?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState(defaultNote);

  function handleResolve() {
    const finalNote = isFlag
      ? `Flagged for next session: ${note.trim() || defaultNote}`
      : note.trim();
    if (!finalNote) {
      toast.warning("Add a note first.");
      return;
    }
    startTransition(async () => {
      const result = await bulkMarkSourceResolved(source, finalNote);
      if (result.ok) {
        toast.success(
          isFlag
            ? `Flagged ${result.resolved ?? 0} rows for Claude.`
            : `Marked ${result.resolved ?? 0} rows resolved.`,
        );
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
        className={
          isFlag
            ? "text-xs px-3 py-1 rounded bg-[#b3412e] text-white hover:bg-[#9a3525] font-medium"
            : "text-xs px-3 py-1 rounded border border-[#dad4cb] bg-white hover:bg-[#f4f1ed] font-medium"
        }
      >
        {isFlag ? `Flag all ${count} for Claude` : `Mark all ${count} resolved`}
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
        placeholder={isFlag ? "Anything Claude should know? (optional)" : "Note (e.g. cleaned up — Brevo will catch up)"}
      />
      <button
        type="button"
        onClick={handleResolve}
        disabled={pending}
        className={
          isFlag
            ? "text-xs px-3 py-1 rounded bg-[#b3412e] text-white hover:bg-[#9a3525] disabled:opacity-50 font-medium"
            : "text-xs px-3 py-1 rounded bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-50 font-medium"
        }
      >
        {pending ? (isFlag ? "Flagging…" : "Resolving…") : isFlag ? `Flag ${count}` : `Confirm ${count}`}
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
