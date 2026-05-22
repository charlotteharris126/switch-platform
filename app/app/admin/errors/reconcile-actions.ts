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
  kind:
    | "db_open_sheet_terminal"
    | "db_terminal_sheet_other"
    | "db_missing_sheet_terminal"
    | "db_lost_same_status_different_reason";
  from_status: string;
  to_status: string;
  lost_reason: string | null;
  // Populated when kind = db_lost_same_status_different_reason so the
  // panel can show "Funding issue → Not interested" alongside the row.
  from_lost_reason?: string | null;
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
  drift_db_fresher_submission_ids: number[];
  drift_target_disallowed_submission_ids?: number[];
  drift_target_disallowed_details?: Array<{
    submission_id: number;
    db_status: string;
    sheet_status: string | null;
  }>;
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
  submission_ids?: number[];
}): Promise<RepublishSheetResult> {
  return callEdgeFunction("republish-provider-sheet", {
    provider_id: args.provider_id,
    apply: args.apply,
    ...(args.submission_ids ? { submission_ids: args.submission_ids } : {}),
  }) as Promise<RepublishSheetResult>;
}

// =============================================================================
// Netlify ↔ DB reconcile
// =============================================================================
//
// Wraps the existing netlify-leads-reconcile Edge Function. The function
// already does back-fill (apply mode) on an hourly cron; this panel exposes
// the new dry-run mode so the operator can see the drift before a back-fill
// fires, and trigger an out-of-band back-fill without waiting for the cron.

export interface NetlifyReconcileBackfill {
  submission_id: number | null;
  netlify_id: string;
  form_name: string;
  course_id: string | null;
  email: string | null;
  created_at: string | null;
}

export interface NetlifyReconcileSummary {
  ok: true;
  mode: "dry_run" | "apply";
  window_hours: number;
  netlify_seen: number;
  already_present: number;
  backfilled: number;
  would_backfill: number;
  errors: number;
  backfills: NetlifyReconcileBackfill[];
  errors_detail: Array<{ netlify_id: string; error: string }>;
  ran_at: string;
}

export type NetlifyReconcileResult = NetlifyReconcileSummary | { ok: false; error: string };

export async function netlifyReconcileAction(args: {
  apply: boolean;
}): Promise<NetlifyReconcileResult> {
  return callEdgeFunction("netlify-leads-reconcile", {
    apply: args.apply,
  }) as Promise<NetlifyReconcileResult>;
}

// =============================================================================
// DB ↔ Brevo (full SW_* attribute reconcile)
// =============================================================================
//
// Successor to the 024 `runNonceBackfillAction` panel. Walks Brevo's contact
// list, projects each contact's submission through the canonical
// upsertLearnerInBrevo / upsertLearnerInBrevoNoMatch builders, and reports
// per-attribute drift. Apply re-fires the canonical upsert for every
// drifted contact.

export interface BrevoDriftEntry {
  email: string;
  submission_id: number;
  mode: "matched" | "no_match" | "pending";
  drifted_attrs: string[];
}

export interface BrevoReconcileSummary {
  ok: true;
  mode: "dry_run" | "apply";
  audience_size: number;
  processed: number;
  contacts_with_drift: number;
  contacts_aligned: number;
  skipped_no_submission: number;
  skipped_no_email: number;
  per_attribute_drift: Record<string, number>;
  drift_list: BrevoDriftEntry[];
  applied_count: number;
  errors: number;
  error_messages: string[];
  ran_at: string;
}

export interface BrevoReconcileAsyncStarted {
  ok: true;
  started: true;
  async: true;
  started_at: string;
  note?: string;
}

export type BrevoReconcileResult =
  | BrevoReconcileSummary
  | BrevoReconcileAsyncStarted
  | { ok: false; error: string };

// Apply mode at 300+ drift × 250ms inter-write delay blows past Netlify's 26s
// Server Action cap, so the panel passes asyncApply=true and the EF runs the
// apply in the background via EdgeRuntime.waitUntil. Dry-run stays
// synchronous — ~5-15s walk fits comfortably in the cap.
export async function brevoAttributeReconcileAction(args: {
  apply: boolean;
  asyncApply?: boolean;
}): Promise<BrevoReconcileResult> {
  return callEdgeFunction("brevo-attribute-reconcile", {
    apply: args.apply,
    ...(args.asyncApply ? { async_apply: true } : {}),
  }) as Promise<BrevoReconcileResult>;
}

// =============================================================================
// Netlify ↔ DB reconcile
// =============================================================================

export interface ErasureSheetEntry {
  provider_id: string;
  company_name: string | null;
  status: "deleted" | "failed" | "skipped_unsupported" | "skipped_no_webhook";
  error?: string;
}

export interface ErasureSummary {
  ok: true;
  mode: "dry_run" | "apply";
  email: string;
  submission_ids: number[];
  supabase_result: {
    submission_ids: number[];
    rows_deleted: {
      submissions: number;
      fastrack_submissions: number;
      enrolments: number;
      lead_notes: number;
      routing_log: number;
      dead_letter_matched: number;
    };
  };
  brevo_result: { ok: boolean; error?: string };
  sheet_result: {
    providers: ErasureSheetEntry[];
    deleted_count: number;
    failed_count: number;
  };
  erasure_request_id: number | null;
}

export type ErasureResult = ErasureSummary | { ok: false; error: string };

export async function gdprEraseLearnerAction(args: {
  email: string;
  apply: boolean;
  reason?: string;
}): Promise<ErasureResult> {
  // Resolve the calling admin's auth.users.id so the receipt links to a
  // real processor. callEdgeFunction re-checks admin, but we need the
  // ID here for the body.
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user || !isAdmin(userData.user.email)) {
    return { ok: false, error: "Not authorised" };
  }
  return callEdgeFunction("gdpr-erase-learner", {
    email: args.email,
    apply: args.apply,
    ...(args.reason ? { reason: args.reason } : {}),
    processed_by: userData.user.id,
  }) as Promise<ErasureResult>;
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
