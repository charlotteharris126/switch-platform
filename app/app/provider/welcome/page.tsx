// /provider/welcome. Swipe-through introduction to the portal for
// brand-new provider users. Shareable URL — linked from the invite
// email body and from /provider/support. Not gated to first-login;
// any team member can revisit it.
//
// Audience-aware: reads the provider's funding_types and renders the
// employer-apprenticeship deck for Riverside, the learner deck for
// EMS / CD / WYK. Same vocabulary as the rest of the portal so the
// mini-visuals match what the user actually sees once they're in.

import { createAdminClient } from "@/lib/supabase/admin";
import { requireProviderUser } from "@/lib/auth/require-provider";
import { WelcomeDeck } from "./welcome-deck";

export const metadata = {
  title: "Welcome, SwitchLeads",
  robots: { index: false, follow: false },
};

export default async function ProviderWelcomePage() {
  const ctx = await requireProviderUser();

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
    />
  );
}
