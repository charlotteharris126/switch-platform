"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { toggleTestFlag } from "./actions";

export function TestFlagToggle({
  submissionId,
  isTest,
}: {
  submissionId: number;
  isTest: boolean;
}) {
  const [pending, startTransition] = useTransition();

  function handleToggle() {
    startTransition(async () => {
      const result = await toggleTestFlag(submissionId, !isTest);
      if (result.ok) {
        toast.success(isTest ? "Test flag removed" : "Marked as test lead");
      } else {
        toast.error(result.error ?? "Failed to update flag");
      }
    });
  }

  return (
    <button
      onClick={handleToggle}
      disabled={pending}
      className="text-xs text-[#5a6a72] hover:text-[#11242e] underline underline-offset-2 disabled:opacity-50"
    >
      {pending ? "Saving…" : isTest ? "Remove test flag" : "Mark as test lead"}
    </button>
  );
}