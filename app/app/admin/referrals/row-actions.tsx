"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  approveManualReview,
  markReferralPaid,
  rejectManualReview,
} from "./actions";

export function MarkPaidRowAction({ referralId }: { referralId: number }) {
  const [open, setOpen] = useState(false);
  const [orderId, setOrderId] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        className="bg-[#287271] hover:bg-[#206462] text-white"
        onClick={() => setOpen(true)}
      >
        Mark paid
      </Button>
    );
  }

  return (
    <form
      className="flex flex-col gap-2 p-3 bg-[#FAF3DC] border border-[#E9C46A] rounded-md"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await markReferralPaid({
            referralId,
            amazonOrderId: orderId,
            notes: notes || null,
          });
          if (!result.ok) {
            setError(result.error ?? "Failed to mark paid");
            return;
          }
          setOpen(false);
          setOrderId("");
          setNotes("");
        });
      }}
    >
      <div>
        <Label htmlFor={`order-${referralId}`} className="text-[10px] font-bold uppercase tracking-[1px] text-[#5a6a72]">
          Amazon order ID (or any reference)
        </Label>
        <Input
          id={`order-${referralId}`}
          type="text"
          value={orderId}
          onChange={(e) => setOrderId(e.target.value)}
          placeholder="e.g. 026-1234567-8901234"
          required
          autoFocus
          className="mt-1 text-xs"
        />
      </div>
      <div>
        <Label htmlFor={`notes-${referralId}`} className="text-[10px] font-bold uppercase tracking-[1px] text-[#5a6a72]">
          Notes (optional)
        </Label>
        <Input
          id={`notes-${referralId}`}
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything worth recording for the audit trail"
          className="mt-1 text-xs"
        />
      </div>
      {error ? <p className="text-xs text-[#b3412e]">{error}</p> : null}
      <div className="flex gap-2 mt-1">
        <Button type="submit" size="sm" disabled={pending} className="bg-[#287271] hover:bg-[#206462] text-white">
          {pending ? "Saving..." : "Confirm paid"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function ManualReviewRowAction({ referralId }: { referralId: number }) {
  const [mode, setMode] = useState<"idle" | "approve" | "reject">("idle");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (mode === "idle") {
    return (
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          className="bg-[#287271] hover:bg-[#206462] text-white"
          onClick={() => setMode("approve")}
        >
          Approve
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="border-[#cd8b76] text-[#cd8b76] hover:bg-[#fce1d6]"
          onClick={() => setMode("reject")}
        >
          Reject
        </Button>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-2 p-3 bg-[#FAF3DC] border border-[#E9C46A] rounded-md"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const result =
            mode === "approve"
              ? await approveManualReview({ referralId, notes: notes || null })
              : await rejectManualReview({ referralId, reason, notes: notes || null });
          if (!result.ok) {
            setError(result.error ?? "Action failed");
            return;
          }
          setMode("idle");
          setReason("");
          setNotes("");
        });
      }}
    >
      <p className="text-[11px] text-[#5a6a72]">
        {mode === "approve"
          ? "Confirm: this referrer is legitimate. Clears the soft-cap flag and returns the referral to the eligible queue."
          : "Confirm: this referral is suspect. Marks it fraud_rejected. No voucher will be sent."}
      </p>
      {mode === "reject" ? (
        <div>
          <Label htmlFor={`reason-${referralId}`} className="text-[10px] font-bold uppercase tracking-[1px] text-[#5a6a72]">
            Reason tag (short)
          </Label>
          <Input
            id={`reason-${referralId}`}
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. clustered_signups, fake_friends"
            required
            autoFocus
            className="mt-1 text-xs"
          />
        </div>
      ) : null}
      <div>
        <Label htmlFor={`note-${referralId}`} className="text-[10px] font-bold uppercase tracking-[1px] text-[#5a6a72]">
          Notes (optional)
        </Label>
        <Input
          id={`note-${referralId}`}
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything worth recording for the audit trail"
          className="mt-1 text-xs"
        />
      </div>
      {error ? <p className="text-xs text-[#b3412e]">{error}</p> : null}
      <div className="flex gap-2 mt-1">
        <Button
          type="submit"
          size="sm"
          disabled={pending}
          className={
            mode === "approve"
              ? "bg-[#287271] hover:bg-[#206462] text-white"
              : "bg-[#cd8b76] hover:bg-[#b3412e] text-white"
          }
        >
          {pending ? "Saving..." : mode === "approve" ? "Confirm approve" : "Confirm reject"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setMode("idle");
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
