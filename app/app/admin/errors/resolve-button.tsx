"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { markErrorResolved } from "./actions";

interface Props {
  errorId: number;
  defaultNote: string;
}

// One-click resolve. Clicking the button immediately marks the row resolved
// using `defaultNote` (severity-appropriate text passed in by the parent).
// "Add note" reveals an optional textbox for owners who want to record more
// context — but the common case is one click and done.
export function ResolveButton({ errorId, defaultNote }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [showNote, setShowNote] = useState(false);
  const [note, setNote] = useState("");

  function resolve(noteText: string) {
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
        placeholder="Optional note"
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
