"use server";

// Server Action that marks the signed-in provider user's welcome-deck
// completion. Called by the final-slide CTA in welcome-deck.tsx.
//
// Idempotent: re-running for a user who's already completed is a no-op
// (the UPDATE matches zero rows; the redirect still fires). That keeps
// the /provider/support "Get started" revisit clean — the column doesn't
// flip backwards.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireProviderUser } from "@/lib/auth/require-provider";

export async function markWelcomeCompleted(): Promise<void> {
  const ctx = await requireProviderUser({ skipWelcomeGate: true });

  const admin = createAdminClient();
  await admin
    .schema("crm")
    .from("provider_users")
    .update({ welcome_completed_at: new Date().toISOString() })
    .eq("id", ctx.providerUserId)
    .is("welcome_completed_at", null);

  // /provider re-runs requireProviderUser on next navigation; revalidate
  // so the new welcome_completed_at value is read fresh.
  revalidatePath("/provider");
  redirect("/provider");
}
