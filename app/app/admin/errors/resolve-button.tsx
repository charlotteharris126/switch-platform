"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { markErrorResolved } from "./actions";

interface Props {
  errorId: number;
  defaultNote: string;
  // requireNote = true is the FIX-severity flow: owner cannot fix the
  // error themselves (it's a code/migration job for Claude), so the button
  // becomes "Flag for Claude" and the saved note is prefixed so it's
  // greppable next platform session. Owner can add optional context.
  // false = clean/info rows: one-click straight dismissal, no prefix.
  requireNote?: boolean;
}

export function ResolveButton({ errorId, defaultNote, requireNote = false }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [showNote, setShowNote] = useState(false);
  const [note, setNote] = useState("");

  function resolve(noteText: string) {
    // FIX-severity rows always get the "Flagged for next session" prefix so
    // they're greppable in the audit trail — even if owner skips the
    // optional context field. CLEAN/INFO rows take the note as-is.
    const finalNote = requireNote
      ? `Flagged for next session${noteText.trim() ? `: ${noteText.trim()}` : ""}`
      : noteText.trim() || defaultNote;
    startTransition(async () => {
      const result = await markErrorResolved(errorId, finalNote);
      if (result.ok) {
        toast.success(requireNote ? "Flagged for Claude." : "Marked resolved.");
        router.refresh();
      } else {
        toast.error("Failed", { description: result.error });
      }
    });
  }

  if (!showNote) {
    if (requireNote) {
      return (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => resolve("")}
            disabled={pending}
            className="text-[10px] font-bold uppercase tracking-wide text-white bg-[#b3412e] hover:bg-[#9a3525] disabled:opacity-40 px-3 h-7 rounded"
          >
            {pending ? "..." : "Flag for Claude"}
          </button>
          <button
            type="button"
            onClick={() => setShowNote(true)}
            disabled={pending}
            className="text-[10px] text-[#5a6a72] hover:text-[#11242e] underline"
          >
            add context first
          </button>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => resolve(defaultNote)}
          disabled={pending}
          className="text-[10px] font-bold uppercase tracking-wide text-white bg-[#143643] hover:bg-[#11242e] disabled:opacity-40 px-3 h-7 rounded"
        >
          {pending ? "..." : "Mark resolved"}
        </button>
        <button
          type="button"
          onClick={() => setShowNote(true)}
          disabled={pending}
          className="text-[10px] text-[#5a6a72] hover:text-[#11242e] underline"
        >
          add note
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={requireNote ? "Anything you noticed? (optional)" : "Optional note"}
        disabled={pending}
        className="text-[10px] border border-[#dad4cb] rounded px-2 h-7 bg-white text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76] w-48"
      />
      <button
        type="button"
        onClick={() => resolve(note)}
        disabled={pending}
        className="h-7 px-2 text-[10px] font-bold uppercase tracking-wide rounded bg-[#143643] text-white hover:bg-[#11242e] disabled:opacity-40"
      >
        {pending ? "..." : requireNote ? "Flag" : "Save"}
      </button>
      <button
        type="button"
        onClick={() => { setShowNote(false); setNote(""); }}
        disabled={pending}
        className="text-[10px] text-[#5a6a72] hover:text-[#11242e]"
      >
        Cancel
      </button>
    </div>
  );
}
