"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  markEnrolmentOutcome,
  type EnrolmentStatus,
  type LostReason,
} from "@/app/admin/leads/[id]/actions";

interface Props {
  submissionId: number;
  currentStatus: string;
}

const LOST_REASONS: Array<{ value: LostReason; label: string }> = [
  { value: "not_interested", label: "Not interested" },
  { value: "wrong_course",   label: "Wrong course" },
  { value: "funding_issue",  label: "Funding issue" },
  { value: "other",          label: "Other" },
];

// Inline pill-buttons for marking an enrolment outcome straight from the
// Actions page (Presumed enrolled section). Open / Enrolled fire on click.
// Lost expands a reason picker because crm.upsert_enrolment_outcome rejects
// status='lost' without a lost_reason.
export function InlineOutcomeButtons({ submissionId, currentStatus }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [askingReason, setAskingReason] = useState(false);

  function fire(status: EnrolmentStatus, lostReason: LostReason | null = null) {
    startTransition(async () => {
      const result = await markEnrolmentOutcome({
        submissionId,
        status,
        notes: null,
        lostReason,
        disputed: false,
        disputedReason: null,
      });
      if (result.ok) {
        toast.success(`Marked ${status.replace(/_/g, " ")}.`);
        setAskingReason(false);
        router.refresh();
      } else {
        toast.error("Save failed", { description: result.error ?? "Unknown error." });
      }
    });
  }

  if (askingReason) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[10px] font-bold uppercase tracking-wide text-[#5a6a72] mr-1">Reason:</span>
        {LOST_REASONS.map((r) => (
          <button
            key={r.value}
            type="button"
            onClick={() => fire("lost", r.value)}
            disabled={pending}
            className="text-[10px] font-bold uppercase tracking-wide px-2 h-7 rounded-full border border-[#dad4cb] bg-white hover:border-[#cd8b76]/60 disabled:opacity-40"
          >
            {r.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setAskingReason(false)}
          disabled={pending}
          className="text-[10px] text-[#5a6a72] hover:text-[#11242e] underline ml-1"
        >
          cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {currentStatus !== "open" && (
        <button
          type="button"
          onClick={() => fire("open")}
          disabled={pending}
          className="text-[10px] font-bold uppercase tracking-wide px-2 h-7 rounded-full border border-[#dad4cb] bg-white hover:border-[#cd8b76]/60 disabled:opacity-40"
        >
          Re-open
        </button>
      )}
      <button
        type="button"
        onClick={() => fire("enrolled")}
        disabled={pending}
        className="text-[10px] font-bold uppercase tracking-wide px-2 h-7 rounded-full bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-40"
      >
        Enrolled
      </button>
      <button
        type="button"
        onClick={() => setAskingReason(true)}
        disabled={pending}
        className="text-[10px] font-bold uppercase tracking-wide px-2 h-7 rounded-full bg-[#143643] text-white hover:bg-[#11242e] disabled:opacity-40"
      >
        Lost
      </button>
    </div>
  );
}
