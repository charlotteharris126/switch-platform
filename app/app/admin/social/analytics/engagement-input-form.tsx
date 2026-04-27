"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { logEngagementSnapshot } from "./actions";

interface Props {
  draftId: string;
  initialReactions: number | null;
  initialComments: number | null;
}

function parseNum(value: string): number | null {
  if (!value || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

export function EngagementInputForm({ draftId, initialReactions, initialComments }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reactions, setReactions] = useState(initialReactions?.toString() ?? "");
  const [comments, setComments] = useState(initialComments?.toString() ?? "");

  function handleSave() {
    const r = parseNum(reactions);
    const c = parseNum(comments);
    if (r === null && c === null) {
      toast.warning("Enter at least one number.");
      return;
    }
    startTransition(async () => {
      const result = await logEngagementSnapshot({
        draftId,
        reactions: r,
        comments: c,
        shares: null,
      });
      if (result.ok) {
        toast.success("Saved.");
        router.refresh();
      } else {
        toast.error("Save failed", { description: result.error });
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-1 text-[11px] text-[#5a6a72]">
        <span className="font-bold uppercase tracking-wide text-[10px]">Likes</span>
        <input
          type="number"
          min={0}
          value={reactions}
          onChange={(e) => setReactions(e.target.value)}
          disabled={pending}
          className="w-16 h-8 px-2 text-xs border border-[#dad4cb] rounded bg-white text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76]"
        />
      </label>
      <label className="flex items-center gap-1 text-[11px] text-[#5a6a72]">
        <span className="font-bold uppercase tracking-wide text-[10px]">Comments</span>
        <input
          type="number"
          min={0}
          value={comments}
          onChange={(e) => setComments(e.target.value)}
          disabled={pending}
          className="w-16 h-8 px-2 text-xs border border-[#dad4cb] rounded bg-white text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76]"
        />
      </label>
      <button
        type="button"
        onClick={handleSave}
        disabled={pending}
        className="h-8 px-3 text-[10px] font-bold uppercase tracking-[0.08em] rounded-full bg-[#143643] text-white hover:bg-[#11242e] active:scale-[0.97] transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {pending ? "Saving..." : "Save"}
      </button>
    </div>
  );
}
