// /admin/preview/[provider_id]/welcome — admin impersonation of
// /provider/welcome. Resolves the target provider, picks learner or
// employer deck from funding_types, and renders the same WelcomeDeck
// component the real provider sees.
//
// User-facing URL is /preview/<provider_id>/welcome — proxy.ts rewrites
// it into /admin/preview/<provider_id>/welcome for routing.

import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminUser } from "@/lib/auth/require-admin";
import { PreviewHeader } from "../preview-header";
import { WelcomeDeck } from "@/app/provider/welcome/welcome-deck";
import { previewWelcomeComplete } from "./actions";

interface ProviderRow {
  provider_id: string;
  company_name: string;
  funding_types: string[] | null;
  is_demo: boolean;
  agreement_version: "v1" | "v2" | null;
  sla_first_attempt_hours: number;
  sla_attempts_required: number;
  sla_attempt_window_days: number;
  sla_stale_attempt_hours: number;
  sla_presumed_flip_days: number;
}

interface Props {
  params: Promise<{ provider_id: string }>;
}

export default async function PreviewWelcomePage({ params }: Props) {
  await requireAdminUser();
  const { provider_id: rawId } = await params;
  const providerId = decodeURIComponent(rawId);

  const admin = createAdminClient();
  const { data: provider } = await admin
    .schema("crm")
    .from("providers")
    .select("provider_id, company_name, funding_types, is_demo, agreement_version, sla_first_attempt_hours, sla_attempts_required, sla_attempt_window_days, sla_stale_attempt_hours, sla_presumed_flip_days")
    .eq("provider_id", providerId)
    .maybeSingle<ProviderRow>();
  if (!provider) notFound();

  const isEmployer =
    Array.isArray(provider.funding_types) &&
    provider.funding_types.includes("apprenticeship");

  return (
    <>
      <PreviewHeader
        providerId={providerId}
        companyName={provider.company_name}
        isDemo={provider.is_demo}
        active="welcome"
      />
      <WelcomeDeck
        audience={isEmployer ? "employer" : "learner"}
        greetingName="there"
        providerLabel={provider.company_name}
        slaTerms={{
          agreementVersion: provider.agreement_version ?? "v1",
          firstAttemptHours: provider.sla_first_attempt_hours,
          attemptsRequired: provider.sla_attempts_required,
          attemptWindowDays: provider.sla_attempt_window_days,
          staleAttemptHours: provider.sla_stale_attempt_hours,
          presumedFlipDays: provider.sla_presumed_flip_days,
        }}
        isAdmin={true}
        onComplete={previewWelcomeComplete.bind(null, providerId)}
      />
    </>
  );
}
