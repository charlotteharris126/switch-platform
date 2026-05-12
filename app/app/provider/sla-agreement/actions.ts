"use server";

// Server action: provider clicks "I agree" on the in-portal SLA
// re-agreement page. Stamps crm.providers with sla_accepted_at +
// sla_accepted_by_user_id + sla_accepted_version. Writes an audit row
// so the acceptance is traceable.
//
// Until this fires, the provider can't access the rest of the portal
// (layout gate at /provider/layout.tsx redirects unaccepted users).
// Auto-flip cron also gates on this — leads under an unaccepted
// provider don't get auto-flipped to Presumed.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const SLA_VERSION = "v1-2026-05-12";

// Form-action signature: takes FormData (unused — this is a "click I
// agree" form with no fields) and returns void (redirect throws). Any
// error path throws to surface in the Next.js error boundary.
export async function acceptSlaAction(_formData: FormData): Promise<void> {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    redirect("/provider-login");
  }

  const admin = createAdminClient();
  // Find this user's provider_users row → which provider they belong to.
  const { data: pu, error: puErr } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, provider_id, role")
    .eq("auth_user_id", userData.user.id)
    .eq("status", "active")
    .maybeSingle<{ id: number; provider_id: string; role: string }>();
  if (puErr || !pu) {
    throw new Error("Couldn't resolve your provider account. Email support@switchleads.co.uk.");
  }
  // Only the provider admin can accept on behalf of the company. Defends
  // against a misordered invite where a team member signs in before the
  // admin (rare — admin is always the first invitee — but defensive
  // belt-and-braces). UI also enforces this so the button isn't even
  // shown for non-admins.
  if (pu.role !== "provider_admin") {
    throw new Error("Only the provider admin can accept the SLA. Ask your admin to sign in first.");
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await admin
    .schema("crm")
    .from("providers")
    .update({
      sla_accepted_at:         nowIso,
      sla_accepted_by_user_id: pu.id,
      sla_accepted_version:    SLA_VERSION,
      updated_at:              nowIso,
    })
    .eq("provider_id", pu.provider_id);

  if (updErr) {
    throw new Error(`SLA acceptance save failed: ${updErr.message}`);
  }

  // Audit. Uses the public RPC wrapper so the audit schema doesn't have
  // to be in the Data API exposed-schemas list. Best-effort: if audit
  // write fails, the acceptance still landed — log but don't block.
  const { error: auditErr } = await admin.rpc("log_provider_action_v1", {
    p_action:       "accept_sla",
    p_target_table: "crm.providers",
    p_target_id:    pu.provider_id,
    p_before:       null,
    p_after:        { sla_accepted_at: nowIso, sla_accepted_version: SLA_VERSION },
    p_context:      { provider_user_id: pu.id, accepted_by_auth_user_id: userData.user.id },
  });
  if (auditErr) {
    console.error("SLA acceptance audit write failed:", auditErr.message);
  }

  revalidatePath("/provider");
  redirect("/provider");
}
