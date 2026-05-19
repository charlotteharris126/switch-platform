"use server";

// Server Actions for /admin/data-ops. Each action wraps a one-shot Edge
// Function trigger. AUDIT_SHARED_SECRET is read from the vault on each
// call (single source of truth — same pattern as sendPortalInviteAction
// and inviteProviderUserAction).

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/auth/allowlist";

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
