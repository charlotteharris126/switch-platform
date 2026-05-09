"use server";

// Server Action — provider marks an outcome on one of their leads.
//
// Auth: the authenticated client (cookie session) is used. RLS policies
// from migration 0096 limit which crm.enrolments rows the provider can
// UPDATE; we don't repeat those checks here. Server-side validation is
// limited to status enum (CHECK constraint enforces too) + lost_reason.
//
// Audit: every change writes through public.log_provider_action_v1 (the
// public-schema wrapper over audit.log_provider_action — the audit schema
// itself is not exposed in the Data API). Surfaces audit failures to the
// caller rather than swallowing, so a failed write is visible. Atomic
// (UPDATE + audit in one transaction) is a pending refinement.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

const VALID_STATUSES = new Set([
  "open",
  "attempt_1_no_answer",
  "attempt_2_no_answer",
  "attempt_3_no_answer",
  "enrolment_meeting_booked",
  "enrolled",
  "lost",
  "cannot_reach",
]);

const VALID_LOST_REASONS = new Set([
  "not_interested",
  "wrong_course",
  "funding_issue",
  "cancelled",
  "withdrew_after_enrolment",
  "l3_mismatch_self_reported",
  "cohort_decline",
  "other",
]);

interface Args {
  submissionId: number;
  status: string;
  lostReason?: string | null;
}

type Result = { ok: true } | { ok: false; error: string };

export async function markOutcomeAction(args: Args): Promise<Result> {
  if (!VALID_STATUSES.has(args.status)) {
    return { ok: false, error: `Invalid status: ${args.status}` };
  }
  if (args.status === "lost") {
    if (!args.lostReason || !VALID_LOST_REASONS.has(args.lostReason)) {
      return { ok: false, error: "A lost reason is required" };
    }
  }

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { ok: false, error: "Not signed in" };

  const newLostReason = args.status === "lost" ? args.lostReason ?? null : null;

  // Capture before-state for audit. RLS scopes by provider_id, so this only
  // returns the row if the caller's provider owns it. Race window between
  // this SELECT and the UPDATE is tolerable: same RLS gate on both, no other
  // writer competes for outcome columns.
  const { data: existingRow, error: readError } = await supabase
    .schema("crm")
    .from("enrolments")
    .select("id, status, lost_reason")
    .eq("submission_id", args.submissionId)
    .maybeSingle();

  if (readError) return { ok: false, error: readError.message };
  if (!existingRow) {
    return { ok: false, error: "No enrolment row found, or you don't have access" };
  }

  const before = { status: existingRow.status, lost_reason: existingRow.lost_reason };
  const after = { status: args.status, lost_reason: newLostReason };

  if (before.status === after.status && before.lost_reason === after.lost_reason) {
    return { ok: true };
  }

  const nowIso = new Date().toISOString();
  const { error: updateError } = await supabase
    .schema("crm")
    .from("enrolments")
    .update({
      status: args.status,
      lost_reason: newLostReason,
      status_updated_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", existingRow.id);

  if (updateError) return { ok: false, error: updateError.message };

  const { error: auditError } = await supabase.rpc("log_provider_action_v1", {
    p_action: "mark_outcome",
    p_target_table: "crm.enrolments",
    p_target_id: String(existingRow.id),
    p_before: before,
    p_after: after,
    p_context: { submission_id: args.submissionId },
  });

  if (auditError) {
    return { ok: false, error: `Outcome saved but audit write failed: ${auditError.message}` };
  }

  revalidatePath(`/provider/leads/${args.submissionId}`);
  revalidatePath("/provider/leads");
  revalidatePath("/provider");
  return { ok: true };
}
