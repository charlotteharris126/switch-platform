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

// --- Backfill sheet Submission IDs (legacy rows pre-2026-05-07) ----------

export interface BackfillSheetIdProvider {
  provider_id: string;
  company_name: string;
}

export interface BackfillSheetIdProposed {
  row_index: number;
  submission_id: number;
  match_reason: string;
  sheet: { email: string; course: string; name: string };
}

export interface BackfillSheetIdSkip {
  row_index: number;
  reason: "no_email" | "no_course" | "no_db_match" | "ambiguous_db_match";
  sheet: { email: string | null; course: string | null; name: string | null };
  candidate_ids?: number[];
}

export interface BackfillSheetIdSummary {
  ok: true;
  mode: "dry_run" | "apply";
  provider_id: string;
  company_name: string | null;
  sheet_rows_unidentified: number;
  proposed_assignments: BackfillSheetIdProposed[];
  skipped: BackfillSheetIdSkip[];
  applied_count: number;
  skipped_already_populated: number;
  errors: string[];
}

export type BackfillSheetIdResult = BackfillSheetIdSummary | { ok: false; error: string };

export async function runBackfillSheetIdsAction(args: {
  provider_id: string;
  apply: boolean;
}): Promise<BackfillSheetIdResult> {
  const result = await callEdgeFunctionGeneric("backfill-sheet-submission-ids", {
    provider_id: args.provider_id,
    apply: args.apply,
  });
  return result as BackfillSheetIdResult;
}

async function callEdgeFunctionGeneric(
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
      headers: { "content-type": "application/json", "x-audit-key": secretData },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
  const respBody = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok || respBody.ok !== true) {
    return {
      ok: false,
      error: typeof respBody.error === "string" ? respBody.error : `Edge Function ${resp.status}`,
    };
  }
  return respBody as { ok: true; [k: string]: unknown };
}

// --- Shared call helper ----------------------------------------------------

async function callBackfillFunction(
  functionName: string,
  args: { apply: boolean },
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
      body: JSON.stringify({ apply: args.apply }),
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
