import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProviderTabs } from "../tabs";
import { EditTrustForm } from "../edit-trust-form";

interface ProviderTrustRow {
  provider_id: string;
  company_name: string;
  trust_line: string | null;
  funding_types: string[] | null;
  regions: string[] | null;
  voice_notes: string | null;
}

export default async function ProviderTrustPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: raw } = await params;
  const providerId = decodeURIComponent(raw);

  const supabase = await createClient();

  const { data: provider, error } = await supabase
    .schema("crm")
    .from("providers")
    .select("provider_id, company_name, trust_line, funding_types, regions, voice_notes")
    .eq("provider_id", providerId)
    .maybeSingle<ProviderTrustRow>();

  if (error) {
    return <div className="text-[#b3412e]">Error loading provider: {error.message}</div>;
  }
  if (!provider) notFound();

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <span className="sl-eyebrow mb-2 inline-block">Provider</span>
        <h1 className="text-[28px] font-extrabold text-[#11242e] leading-tight tracking-tight">
          {provider.company_name}
        </h1>
        <p className="text-sm text-[#5a6a72] mt-1">
          Trust content used in Switchable learner emails for leads routed to this provider.
        </p>
      </div>

      <ProviderTabs providerId={providerId} active="trust" />

      <EditTrustForm
        providerId={provider.provider_id}
        initial={{
          trustLine: provider.trust_line,
          fundingTypes: provider.funding_types ?? [],
          regions: provider.regions ?? [],
          voiceNotes: provider.voice_notes,
        }}
      />
    </div>
  );
}
