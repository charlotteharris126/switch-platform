"use server";

// Server Actions for /admin/data-ops. Each action wraps a one-shot Edge
// Function trigger. AUDIT_SHARED_SECRET is read from the vault on each
// call (single source of truth — same pattern as sendPortalInviteAction
// and inviteProviderUserAction).

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/auth/allowlist";

export interface BackfillSpotCheck {
  email: string;
  before_referral: string;
  before_fastrack: string;
  desired_referral: string;
  desired_fastrack: string;
  after_referral?: string;
  after_fastrack?: string;
}

export interface BackfillSummary {
  ok: true;
  mode: "dry_run" | "apply";
  audience_size: number;
  processed: number;
  mutated: number;
  skipped_no_submission: number;
  skipped_already_matching: number;
  errors: number;
  error_messages: string[];
  spot_checks: BackfillSpotCheck[];
}

export type BackfillResult = BackfillSummary | { ok: false; error: string };

export async function runBackfillAction(args: { apply: boolean }): Promise<BackfillResult> {
  return callBackfillFunction("backfill-referral-fastrack-urls", args) as Promise<BackfillResult>;
}

// --- Client-nonce backfill -------------------------------------------------

export interface NonceSpotCheck {
  id: number;
  email: string | null;
  full_name: string;
  funding_category: string | null;
  submitted_at: string;
  new_nonce: string;
  fastrack_url: string;
}

export interface NonceBackfillSummary {
  ok: true;
  mode: "dry_run" | "apply";
  audience_size: number;
  mutated: number;
  spot_checks: NonceSpotCheck[];
}

export type NonceBackfillResult = NonceBackfillSummary | { ok: false; error: string };

export async function runNonceBackfillAction(args: { apply: boolean }): Promise<NonceBackfillResult> {
  return callBackfillFunction("backfill-client-nonce", args) as Promise<NonceBackfillResult>;
}

// --- Sheet ↔ DB reconcile --------------------------------------------------

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

export interface ProviderOption {
  provider_id: string;
  company_name: string;
  is_demo: boolean;
  has_sheet: boolean;
}

export async function listProvidersForReconcileAction(): Promise<ProviderOption[]> {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user || !isAdmin(userData.user.email)) return [];

  const admin = createAdminClient();
  const { data, error } = await admin
    .schema("crm")
    .from("providers")
    .select("provider_id, company_name, is_demo, sheet_webhook_url")
    .eq("active", true)
    .order("is_demo", { ascending: true })
    .order("company_name", { ascending: true });
  if (error || !data) return [];
  return data.map((p: { provider_id: string; company_name: string; is_demo: boolean; sheet_webhook_url: string | null }) => ({
    provider_id: p.provider_id,
    company_name: p.company_name,
    is_demo: p.is_demo,
    has_sheet: p.sheet_webhook_url != null,
  }));
}

// --- Shared call helper ----------------------------------------------------

async function callBackfillFunction(
  functionName: string,
  args: { apply: boolean },
): Promise<{ ok: true; [k: string]: unknown } | { ok: false; error: string }> {
  return callEdgeFunction(functionName, { apply: args.apply });
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
