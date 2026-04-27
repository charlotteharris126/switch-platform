"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { markErrorResolved } from "./actions";

interface Props {
  errorId: number;
}

export function ResolveButton({ errorId }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [showInput, setShowInput] = useState(false);
  const [note, setNote] = useState("");

  function handleResolve() {
    if (!note.trim()) {
      toast.warning("Add a note first.");
      return;
    }
    startTransition(async () => {
      const result = await markErrorResolved(errorId, note.trim());
      if (result.ok) {
        toast.success("Marked resolved.");
        router.refresh();
      } else {
        toast.error("Failed", { description: result.error });
      }
    });
  }

  if (!showInput) {
    return (
      <button
        type="button"
        onClick={() => setShowInput(true)}
        className="text-[10px] font-bold uppercase tracking-wide text-[#cd8b76] hover:text-[#b3412e]"
      >
        Mark resolved
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="How did you fix it?"
        disabled={pending}
        className="text-[10px] border border-[#dad4cb] rounded px-2 h-7 bg-white text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76] w-48"
      />
      <button
        type="button"
        onClick={handleResolve}
        disabled={pending}
        className="h-7 px-2 text-[10px] font-bold uppercase tracking-wide rounded bg-[#143643] text-white hover:bg-[#11242e] disabled:opacity-40"
      >
        {pending ? "..." : "Save"}
      </button>
      <button
        type="button"
        onClick={() => { setShowInput(false); setNote(""); }}
        disabled={pending}
        className="text-[10px] text-[#5a6a72] hover:text-[#11242e]"
      >
        Cancel
      </button>
    </div>
  );
}
