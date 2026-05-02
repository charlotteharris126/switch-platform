"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { fireProviderChaser } from "@/app/admin/leads/bulk-actions";

interface Props {
  submissionId: number;
  label?: string;
}

// One-click "Send chaser" button. Wraps the existing fireProviderChaser
// bulk RPC with a single id. Skipped reasons (already chased recently, no
// Brevo contact) come back per-id; we surface the first skip reason in the
// toast so owner sees why nothing fired.
export function InlineChaserButton({ submissionId, label = "Send chaser" }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function fire() {
    startTransition(async () => {
      const result = await fireProviderChaser([submissionId]);
      if (!result.ok) {
        toast.error("Chaser failed");
        return;
      }
      if (result.fired > 0) {
        toast.success("Chaser sent.");
      } else if (result.perId[0]?.reason) {
        toast.warning("Skipped", { description: result.perId[0].reason });
      } else {
        toast.warning("Skipped");
      }
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={fire}
      disabled={pending}
      className="text-[10px] font-bold uppercase tracking-wide px-2 h-7 rounded-full bg-[#cd8b76] text-white hover:bg-[#b3412e] disabled:opacity-40"
    >
      {pending ? "..." : label}
    </button>
  );
}
