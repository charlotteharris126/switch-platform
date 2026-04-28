"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { deleteManualAdSpend } from "./actions";

export function DeleteButton({ date }: { date: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    if (!confirm(`Delete the manual ad spend row for ${date}?`)) return;
    startTransition(async () => {
      const res = await deleteManualAdSpend(date);
      if (res.ok) {
        toast.success(`Deleted ${date}`);
        router.refresh();
      } else {
        toast.error("Failed", { description: res.error });
      }
    });
  }

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={pending}
      className="text-[10px] font-bold uppercase tracking-wide text-[#5a6a72] hover:text-[#b3412e] disabled:opacity-40"
    >
      {pending ? "..." : "Delete"}
    </button>
  );
}
