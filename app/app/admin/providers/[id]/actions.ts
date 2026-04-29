"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface EditProviderInput {
  providerId: string;
  contactName: string | null;
  contactEmail: string;
  contactPhone: string | null;
  ccEmails: string[];
  autoRouteEnabled: boolean;
  active: boolean;
  pilotStatus: string;
  notes: string | null;
}

export interface EditProviderResult {
  ok: boolean;
  error?: string;
}

export async function editProvider(input: EditProviderInput): Promise<EditProviderResult> {
  const supabase = await createClient();

  const { error } = await supabase.schema("crm").rpc("update_provider", {
    p_provider_id: input.providerId,
    p_contact_name: input.contactName,
    p_contact_email: input.contactEmail,
    p_contact_phone: input.contactPhone,
    p_cc_emails: input.ccEmails,
    p_auto_route_enabled: input.autoRouteEnabled,
    p_active: input.active,
    p_pilot_status: input.pilotStatus,
    p_notes: input.notes,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath(`/providers/${encodeURIComponent(input.providerId)}`);
  revalidatePath("/providers");

  return { ok: true };
}

export interface EditProviderTrustInput {
  providerId: string;
  trustLine: string | null;
  fundingTypes: string[];
  regions: string[];
  voiceNotes: string | null;
}

export async function editProviderTrust(input: EditProviderTrustInput): Promise<EditProviderResult> {
  const supabase = await createClient();

  const { error } = await supabase.schema("crm").rpc("update_provider_trust", {
    p_provider_id: input.providerId,
    p_trust_line: input.trustLine,
    p_funding_types: input.fundingTypes,
    p_regions: input.regions,
    p_voice_notes: input.voiceNotes,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath(`/providers/${encodeURIComponent(input.providerId)}`);
  revalidatePath("/providers");

  return { ok: true };
}
