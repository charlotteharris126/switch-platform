"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { markOwnerTestSubmission } from "./actions";

// Only show the "Remove" affordance when the lead is currently flagged as an
// owner test submission. Other DQ reasons (e.g. waitlist, no_match) are not
// touched by this toggle.
export function OwnerTestToggle({
  submissionId,
  dqReason,
}: {
  submissionId: number;
  dqReason: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const isOwnerTest = dqReason === "owner_test_submission";

  function handleClick() {
    if (!isOwnerTest) {
      const ok = window.confirm(
        "Mark as test lead? This DQs the submission, sets dq_reason to owner_test_submission, and archives it. Use only for your own test submissions.",
      );
      if (!ok) return;
    }
    startTransition(async () => {
      const result = await markOwnerTestSubmission(submissionId, !isOwnerTest);
      if (result.ok) {
        toast.success(isOwnerTest ? "Test flag removed" : "Marked as test lead");
      } else {
        toast.error(result.error ?? "Failed to update");
      }
    });
  }

  return (
    <button
      onClick={handleClick}
      disabled={pending}
      className="text-xs text-[#5a6a72] hover:text-[#11242e] underline underline-offset-2 disabled:opacity-50"
    >
      {pending ? "Saving…" : isOwnerTest ? "Remove test flag" : "Mark as test lead"}
    </button>
  );
}
