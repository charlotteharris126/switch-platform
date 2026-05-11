"use server";

// Server Action: triggers the republish-provider-sheet Edge Function for
// a specific provider. Reads AUDIT_SHARED_SECRET from vault, POSTs to the
// function. Same vault-read pattern as sendPortalInviteAction.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/auth/allowlist";

export interface RepublishSpotCheck {
  submission_id: number;
  status_db: string;
  lost_reason_db: string | null;
  fastracked: boolean;
}

export interface RepublishSummary {
  ok: true;
  mode: "dry_run" | "apply";
  provider_id: string;
  company_name: string | null;
  leads_total: number;
  leads_written: number;
  leads_skipped_no_appender_ack: number;
  errors: number;
  error_messages: string[];
  spot_checks: RepublishSpotCheck[];
}

export type RepublishResult = RepublishSummary | { ok: false; error: string };

export async function republishSheetAction(args: {
  provider_id: string;
  apply: boolean;
}): Promise<RepublishResult> {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user || !isAdmin(userData.user.email)) {
    return { ok: false, error: "Not authorised" };
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    return { ok: false, error: "Server misconfigured: NEXT_PUBLIC_SUPABASE_URL missing" };
  }

  const admin = createAdminClient();
  const { data: secretData, error: secretErr } = await admin.rpc("get_shared_secret", {
    p_name: "AUDIT_SHARED_SECRET",
  });
  if (secretErr || typeof secretData !== "string" || !secretData) {
    return {
      ok: false,
      error: `Could not read AUDIT_SHARED_SECRET from vault: ${secretErr?.message ?? "no value returned"}`,
    };
  }

  let resp: Response;
  try {
    resp = await fetch(`${supabaseUrl}/functions/v1/republish-provider-sheet`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-audit-key": secretData,
      },
      body: JSON.stringify({ provider_id: args.provider_id, apply: args.apply }),
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok || body.ok !== true) {
    return {
      ok: false,
      error: typeof body.error === "string" ? body.error : `Edge Function ${resp.status}`,
    };
  }
  return body as unknown as RepublishSummary;
}
