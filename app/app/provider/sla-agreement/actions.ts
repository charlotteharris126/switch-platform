"use server";

// Server actions for the SLA agreement page:
//   - acceptSlaAction: ANY signed-in provider user (admin or regular)
//     clicks "I agree", stamps their own crm.provider_users row +
//     writes an audit row, redirects to portal home. Per-user, not
//     per-provider: every team member accepts individually so managers
//     don't have to forward the SLA on to new staff (Charlotte
//     2026-05-15).
//   - signOutFromSlaAction: handles the sign-out button on the SLA
//     page (the page sits OUTSIDE the standard ProviderShell so it
//     doesn't get the shell's signout for free).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SLA_VERSION } from "./version";

export async function signOutFromSlaAction(_formData: FormData): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/provider-login");
}

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
  // Find this user's provider_users row.
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

  const nowIso = new Date().toISOString();
  // Per-user acceptance row. Writes to crm.provider_users instead of
  // crm.providers. Provider-level columns on crm.providers stay as
  // historical first-acceptance marker but are no longer the auth gate.
  const { error: updErr } = await admin
    .schema("crm")
    .from("provider_users")
    .update({
      sla_accepted_at:      nowIso,
      sla_accepted_version: SLA_VERSION,
    })
    .eq("id", pu.id);

  if (updErr) {
    throw new Error(`SLA acceptance save failed: ${updErr.message}`);
  }

  // Audit: one row per acceptance, named by user. Best-effort: if
  // audit write fails, the acceptance still landed — log but don't
  // block. RPC must be called via the authenticated supabase client
  // (not admin), because audit.log_provider_action requires auth.uid()
  // to resolve to an active provider_users row.
  const { error: auditErr } = await supabase.rpc("log_provider_action_v1", {
    p_action:       "accept_sla",
    p_target_table: "crm.provider_users",
    p_target_id:    String(pu.id),
    p_before:       null,
    p_after:        { sla_accepted_at: nowIso, sla_accepted_version: SLA_VERSION },
    p_context:      {
      provider_user_id:        pu.id,
      provider_id:             pu.provider_id,
      role:                    pu.role,
      accepted_by_auth_user_id: userData.user.id,
    },
  });
  if (auditErr) {
    console.error("SLA acceptance audit write failed:", auditErr.message);
  }

  revalidatePath("/provider");
  redirect("/provider");
}
