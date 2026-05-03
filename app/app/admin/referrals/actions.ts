"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

// Mark an eligible referral as paid. Owner has just sent the Amazon e-gift card
// manually via amazon.co.uk; we record the order id (or any external reference)
// plus optional notes so the audit trail is complete. Tremendous-from-launch
// was reverted by Mira on 2026-05-04 in favour of manual fulfilment for v1;
// this action is the manual replacement for what payout-referral-voucher would
// have done automatically.
export async function markReferralPaid(input: {
  referralId: number;
  amazonOrderId: string;
  notes: string | null;
}): Promise<ActionResult> {
  const supabase = await createClient();

  const orderId = input.amazonOrderId.trim();
  if (!orderId) {
    return { ok: false, error: "Amazon order ID (or any external reference) is required" };
  }

  const vendorPayload = {
    method: "manual",
    sent_via: "amazon_co_uk_egift",
    sent_at: new Date().toISOString(),
    notes: input.notes?.trim() || null,
  };

  const { error } = await supabase
    .schema("leads")
    .from("referrals")
    .update({
      voucher_status: "paid",
      voucher_paid_at: new Date().toISOString(),
      vendor: "manual_amazon_uk",
      vendor_payment_id: `manual_${orderId}`,
      vendor_payload: vendorPayload,
      notes: input.notes?.trim() || null,
    })
    .eq("id", input.referralId)
    .eq("voucher_status", "eligible")
    .is("voucher_paid_at", null);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/referrals");
  return { ok: true };
}

// Manual review approval: the referrer hit the soft cap (10 successful refs in
// 90 days) and Charlotte has decided this pattern is legitimate. Clear the
// flag; the row returns to the eligible queue and behaves like any other
// eligible referral.
export async function approveManualReview(input: {
  referralId: number;
  notes: string | null;
}): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase
    .schema("leads")
    .from("referrals")
    .update({
      needs_manual_review: false,
      notes: input.notes?.trim() || null,
    })
    .eq("id", input.referralId)
    .eq("needs_manual_review", true);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/referrals");
  return { ok: true };
}

// Manual review rejection: the referral pattern looks suspect after the soft
// cap fired. Terminal — moves to fraud_rejected with a note explaining why.
// fraud_reason carries the operator's tag; notes can carry richer context.
export async function rejectManualReview(input: {
  referralId: number;
  reason: string;
  notes: string | null;
}): Promise<ActionResult> {
  const supabase = await createClient();

  const reason = input.reason.trim();
  if (!reason) {
    return { ok: false, error: "Reason is required to reject a flagged referral" };
  }

  const { error } = await supabase
    .schema("leads")
    .from("referrals")
    .update({
      voucher_status: "fraud_rejected",
      fraud_reason: `manual_review_rejected:${reason}`,
      needs_manual_review: false,
      notes: input.notes?.trim() || null,
    })
    .eq("id", input.referralId)
    .eq("needs_manual_review", true);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/referrals");
  return { ok: true };
}
