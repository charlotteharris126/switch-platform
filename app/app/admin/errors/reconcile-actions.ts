"use server";

// Server Actions for the sheet ↔ DB reconcile panel rendered on Data
// health. Single home for both directions:
//   - reconcileSheetToDbAction → sheet → DB (the new reconcile function)
//   - republishSheetAction     → DB → sheet (the existing republish function)
//
// Both wrap an Edge Function call. AUDIT_SHARED_SECRET is read from
// vault on each call.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/auth/allowlist";

export interface ReconcileProposedChange {
  submission_id: number;
  kind: "db_open_sheet_terminal" | "db_terminal_sheet_other" | "db_missing_sheet_terminal";
  from_status: string;
  to_status: string;
  lost_reason: string | null;
}

export interface ReconcileSheetToDbSummary {
  ok: true;
  mode: "dry_run" | "apply";
  provider_id: string;
  company_name: string | null;
  drift_eligible_total: number;
  drift_skipped_ambiguous: number;
  drift_skipped_no_signal: number;
  drift_skipped_db_fresher: number;
  drift_skipped_target_disallowed: number;
  proposed_changes: ReconcileProposedChange[];
  applied_count: number;
  errors: string[];
  audit_entries: number[];
}

export type ReconcileSheetToDbResult = ReconcileSheetToDbSummary | { ok: false; error: string };

export async function reconcileSheetToDbAction(args: {
  provider_id: string;
  apply: boolean;
  submission_ids?: number[];
}): Promise<ReconcileSheetToDbResult> {
  return callEdgeFunction("reconcile-sheet-to-db", {
    provider_id: args.provider_id,
    apply: args.apply,
    ...(args.submission_ids ? { submission_ids: args.submission_ids } : {}),
  }) as Promise<ReconcileSheetToDbResult>;
}

export interface RepublishSpotCheck {
  submission_id: number;
  status_db: string;
  lost_reason_db: string | null;
  fastracked: boolean;
}

export interface RepublishSheetSummary {
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

export type RepublishSheetResult = RepublishSheetSummary | { ok: false; error: string };

export async function republishSheetAction(args: {
  provider_id: string;
  apply: boolean;
}): Promise<RepublishSheetResult> {
  return callEdgeFunction("republish-provider-sheet", {
    provider_id: args.provider_id,
    apply: args.apply,
  }) as Promise<RepublishSheetResult>;
}

async function callEdgeFunction(
  functionName: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; [k: string]: unknown } | { ok: false; error: string }> {
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
    resp = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-audit-key": secretData,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const responseBody = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok || responseBody.ok !== true) {
    return {
      ok: false,
      error: typeof responseBody.error === "string"
        ? responseBody.error
        : `Edge Function ${resp.status}`,
    };
  }

  return responseBody as { ok: true; [k: string]: unknown };
}
