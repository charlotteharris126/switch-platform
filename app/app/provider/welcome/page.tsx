// /provider/welcome. First-login forced walkthrough.
//
// Gated by requireProviderUser({ skipWelcomeGate: true }) so it doesn't
// bounce to itself. Every other /provider/* route redirects HERE when
// crm.provider_users.welcome_completed_at is NULL. The deck's final-slide
// CTA fires markWelcomeCompleted() which flips that timestamp and
// redirects to /provider.
//
// Repeat visits (via the Support tab's "Get started" card) re-render
// the deck the same way; the Server Action is idempotent so revisiting
// doesn't break anything.

import { createAdminClient } from "@/lib/supabase/admin";
import { requireProviderUser } from "@/lib/auth/require-provider";
import { WelcomeDeck } from "./welcome-deck";
import { markWelcomeCompleted } from "./actions";

export const metadata = {
  title: "Welcome, SwitchLeads",
  robots: { index: false, follow: false },
};

export default async function ProviderWelcomePage() {
  const ctx = await requireProviderUser({ skipWelcomeGate: true });

  const admin = createAdminClient();
  const { data: provider } = await admin
    .schema("crm")
    .from("providers")
    .select("company_name, funding_types")
    .eq("provider_id", ctx.providerId)
    .maybeSingle<{ company_name: string; funding_types: string[] | null }>();

  const isEmployer =
    Array.isArray(provider?.funding_types) &&
    provider!.funding_types!.includes("apprenticeship");

  const greetingName =
    ctx.displayName?.split(" ")[0] ??
    ctx.contactEmail.split("@")[0] ??
    "there";

  return (
    <WelcomeDeck
      audience={isEmployer ? "employer" : "learner"}
      greetingName={greetingName}
      providerLabel={provider?.company_name ?? "Your account"}
      onComplete={markWelcomeCompleted}
    />
  );
}
