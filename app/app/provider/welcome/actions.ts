"use server";

// Server Action that marks BOTH welcome-deck completion AND SLA
// acceptance for the signed-in provider user. Called by the final
// slide's "I agree" button in welcome-deck.tsx.
//
// Per Charlotte 2026-05-15: SLA acceptance happens as the last step
// of the welcome deck, not as a separate page. Every user (admin or
// regular) accepts individually, with an audit row written per
// acceptance.
//
// Idempotent: re-running for a user who's already completed/accepted
// is safe — the UPDATE conditions short-circuit and the redirect
// still fires.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireProviderUser } from "@/lib/auth/require-provider";
import { SLA_VERSION } from "@/app/provider/sla-agreement/version";

export async function markWelcomeAndSlaAccepted(): Promise<void> {
  const ctx = await requireProviderUser({ skipWelcomeGate: true });

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  const { error: updErr } = await admin
    .schema("crm")
    .from("provider_users")
    .update({
      welcome_completed_at: nowIso,
      sla_accepted_at:      nowIso,
      sla_accepted_version: SLA_VERSION,
    })
    .eq("id", ctx.providerUserId);

  if (updErr) {
    throw new Error(`Welcome + SLA save failed: ${updErr.message}`);
  }

  // Audit row for the SLA acceptance. Welcome completion is not
  // separately audited — it's a UX milestone, not a legal commitment.
  const { error: auditErr } = await admin.rpc("log_provider_action_v1", {
    p_action:       "accept_sla",
    p_target_table: "crm.provider_users",
    p_target_id:    String(ctx.providerUserId),
    p_before:       null,
    p_after:        { sla_accepted_at: nowIso, sla_accepted_version: SLA_VERSION },
    p_context:      {
      provider_user_id:        ctx.providerUserId,
      provider_id:             ctx.providerId,
      role:                    ctx.role,
      accepted_by_auth_user_id: ctx.authUserId,
      via:                     "welcome_deck_final_slide",
    },
  });
  if (auditErr) {
    console.error("Welcome+SLA audit write failed:", auditErr.message);
  }

  revalidatePath("/provider");
  redirect("/provider");
}
