// /provider/welcome. First-login forced walkthrough.
//
// Gated by requireProviderUser({ skipWelcomeGate: true }) so it doesn't
// bounce to itself. Every other /provider/* route redirects HERE when
// crm.provider_users.welcome_completed_at OR sla_accepted_at is NULL.
// The deck's final slide is the SLA tick; the Server Action fires
// markWelcomeAndSlaAccepted() which flips BOTH timestamps and writes an
// audit row.
//
// Repeat visits (via the Support tab's "Get started" card) re-render
// the deck the same way; the Server Action is idempotent so revisiting
// doesn't break anything.

import { createAdminClient } from "@/lib/supabase/admin";
import { requireProviderUser } from "@/lib/auth/require-provider";
import { WelcomeDeck } from "./welcome-deck";
import { markWelcomeAndSlaAccepted } from "./actions";

export const metadata = {
  title: "Welcome, SwitchLeads",
  robots: { index: false, follow: false },
};

interface ProviderRow {
  company_name: string;
  funding_types: string[] | null;
  agreement_version: "v1" | "v2" | null;
  sla_first_attempt_hours: number;
  sla_attempts_required: number;
  sla_attempt_window_days: number;
  sla_stale_attempt_hours: number;
  sla_presumed_flip_days: number;
}

export default async function ProviderWelcomePage() {
  const ctx = await requireProviderUser({ skipWelcomeGate: true });

  const admin = createAdminClient();
  const { data: provider } = await admin
    .schema("crm")
    .from("providers")
    .select(
      "company_name, funding_types, agreement_version, sla_first_attempt_hours, sla_attempts_required, sla_attempt_window_days, sla_stale_attempt_hours, sla_presumed_flip_days",
    )
    .eq("provider_id", ctx.providerId)
    .maybeSingle<ProviderRow>();

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
      slaTerms={{
        agreementVersion: provider?.agreement_version ?? "v1",
        firstAttemptHours: provider?.sla_first_attempt_hours ?? 24,
        attemptsRequired: provider?.sla_attempts_required ?? 3,
        attemptWindowDays: provider?.sla_attempt_window_days ?? 7,
        staleAttemptHours: provider?.sla_stale_attempt_hours ?? 36,
        presumedFlipDays: provider?.sla_presumed_flip_days ?? 14,
      }}
      isAdmin={ctx.role === "provider_admin"}
      onComplete={markWelcomeAndSlaAccepted}
    />
  );
}
