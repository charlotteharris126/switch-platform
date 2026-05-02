"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { markErrorResolved } from "./actions";

interface Props {
  errorId: number;
  defaultNote: string;
  // requireNote = true forces the typed-note flow (used for ACTION NEEDED
  // rows so owner has to acknowledge what they actually did to fix it,
  // rather than blind-dismiss real errors). false = one-click for clean/
  // info rows where dismissal is genuinely safe.
  requireNote?: boolean;
}

export function ResolveButton({ errorId, defaultNote, requireNote = false }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [showNote, setShowNote] = useState(false);
  const [note, setNote] = useState("");

  function resolve(noteText: string) {
    if (requireNote && !noteText.trim()) {
      toast.warning("Add a note describing how you handled it.");
      return;
    }
    startTransition(async () => {
      const result = await markErrorResolved(errorId, noteText);
      if (result.ok) {
        toast.success("Marked resolved.");
        router.refresh();
      } else {
        toast.error("Failed", { description: result.error });
      }
    });
  }

  if (!showNote) {
    if (requireNote) {
      return (
        <button
          type="button"
          onClick={() => setShowNote(true)}
          disabled={pending}
          className="text-[10px] font-bold uppercase tracking-wide text-[#11242e] bg-white border border-[#dad4cb] hover:border-[#cd8b76]/60 px-2 h-7 rounded"
        >
          I&rsquo;ve handled this
        </button>
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
        placeholder={requireNote ? "What did you do?" : "Optional note"}
        disabled={pending}
        className="text-[10px] border border-[#dad4cb] rounded px-2 h-7 bg-white text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76] w-48"
      />
      <button
        type="button"
        onClick={() => resolve(note.trim() || defaultNote)}
        disabled={pending}
        className="h-7 px-2 text-[10px] font-bold uppercase tracking-wide rounded bg-[#143643] text-white hover:bg-[#11242e] disabled:opacity-40"
      >
        {pending ? "..." : "Save"}
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
