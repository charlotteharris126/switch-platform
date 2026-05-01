"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Resolve a pending AI suggestion from the dashboard. Mirrors the logic of
// the pending-update-confirm Edge Function (which handles email-link clicks
// via HMAC tokens) — but here the user is already authenticated, so we
// authorise on the session and skip token verification.
//
// On approve/override: applies the chosen status to crm.enrolments,
// updates crm.pending_updates.status, logs the resolution to
// crm.sheet_edits_log. Idempotent on pending_updates.status — repeated
// clicks after the first one are no-ops.

const VALID_OVERRIDE_STATUSES = ["contacted", "enrolled", "not_enrolled", "disputed", "cannot_reach", "presumed_enrolled", "lost"] as const;

export type ResolveResult = {
  ok: boolean;
  message: string;
};

export async function resolvePendingUpdate(
  pendingUpdateId: number,
  action: "approve" | "reject" | "override",
  overrideStatus?: string,
): Promise<ResolveResult> {
  const supabase = await createClient();

  // Auth check — dashboard requires login. Without a session, this is denied.
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    return { ok: false, message: "Not signed in" };
  }

  if (action === "override") {
    if (!overrideStatus || !(VALID_OVERRIDE_STATUSES as readonly string[]).includes(overrideStatus)) {
      return { ok: false, message: "Invalid override status" };
    }
  }

  const { data: pendingRows, error: pendingErr } = await supabase
    .schema("crm")
    .from("pending_updates")
    .select("id, enrolment_id, status, current_status, suggested_status, ai_summary")
    .eq("id", pendingUpdateId)
    .limit(1);

  if (pendingErr || !pendingRows || pendingRows.length === 0) {
    return { ok: false, message: "Suggestion not found" };
  }
  const pending = pendingRows[0];

  if (pending.status !== "pending") {
    return { ok: false, message: `Already ${pending.status}` };
  }

  if (action === "reject") {
    await supabase
      .schema("crm")
      .from("pending_updates")
      .update({
        status: "rejected",
        resolved_at: new Date().toISOString(),
        resolved_by: "owner",
      })
      .eq("id", pendingUpdateId)
      .eq("status", "pending");

    await logResolution(supabase, pending, "ai_rejected", null);
    revalidatePath("/sheet-activity");
    return { ok: true, message: "Rejected" };
  }

  // approve / override path
  const newStatus = action === "approve" ? pending.suggested_status : overrideStatus!;
  const pendingResolution = action === "approve" ? "approved" : "overridden";

  // Read current enrolment state to gate billed/paid
  const { data: enrolRow } = await supabase
    .schema("crm")
    .from("enrolments")
    .select("status")
    .eq("id", pending.enrolment_id)
    .limit(1);

  const currentStatus = enrolRow?.[0]?.status;
  if (!currentStatus) {
    return { ok: false, message: "Enrolment not found" };
  }
  if (currentStatus === "billed" || currentStatus === "paid") {
    return { ok: false, message: `Already ${currentStatus} — go through dispute flow` };
  }

  if (currentStatus !== newStatus) {
    await supabase
      .schema("crm")
      .from("enrolments")
      .update({
        status: newStatus,
        status_updated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", pending.enrolment_id);

    if (newStatus === "disputed") {
      await supabase.schema("crm").from("disputes").insert({
        enrolment_id: pending.enrolment_id,
        raised_by: "owner",
        reason: `AI ${pendingResolution} via dashboard: ${pending.ai_summary ?? "no summary"}`,
      });
    }
  }

  await supabase
    .schema("crm")
    .from("pending_updates")
    .update({
      status: pendingResolution,
      override_status: action === "override" ? newStatus : null,
      resolved_at: new Date().toISOString(),
      resolved_by: "owner",
      applied_at: new Date().toISOString(),
    })
    .eq("id", pendingUpdateId)
    .eq("status", "pending");

  await logResolution(supabase, pending, action === "approve" ? "ai_approved" : "ai_overridden", newStatus);
  revalidatePath("/sheet-activity");
  return { ok: true, message: action === "approve" ? "Approved" : `Set to ${newStatus}` };
}

async function logResolution(
  supabase: Awaited<ReturnType<typeof createClient>>,
  pending: { id: number; enrolment_id: number; current_status: string; suggested_status: string },
  auditAction: string,
  appliedStatus: string | null,
) {
  // Look up the original sheet edit log row to grab provider/submission context
  const { data: origRows } = await supabase
    .schema("crm")
    .from("sheet_edits_log")
    .select("provider_id, submission_id, column_name")
    .eq("pending_update_id", pending.id)
    .order("id", { ascending: true })
    .limit(1);

  const orig = origRows?.[0];
  if (!orig) return;

  await supabase.schema("crm").from("sheet_edits_log").insert({
    enrolment_id: pending.enrolment_id,
    submission_id: orig.submission_id,
    provider_id: orig.provider_id,
    column_name: orig.column_name,
    old_value: pending.current_status,
    new_value: appliedStatus,
    editor_email: "owner@dashboard",
    edited_at: new Date().toISOString(),
    action: auditAction,
    applied_status: appliedStatus,
    pending_update_id: pending.id,
    reason: "Resolved by owner via dashboard",
  });
}
