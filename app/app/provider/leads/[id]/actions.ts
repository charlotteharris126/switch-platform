"use server";

// Server Action — provider marks an outcome on one of their leads.
//
// Auth: the authenticated client (cookie session) is used. RLS policies
// from migration 0096 limit which crm.enrolments rows the provider can
// UPDATE; we don't repeat those checks here. Server-side validation is
// limited to status enum (CHECK constraint enforces too) + lost_reason.
//
// Audit: every change writes through audit.log_provider_action so the
// admin-side activity panel can replay outcome history.

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

  const update: Record<string, unknown> = {
    status: args.status,
    status_updated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (args.status === "lost") {
    update.lost_reason = args.lostReason;
  } else {
    update.lost_reason = null;
  }

  // RLS on crm.enrolments scopes by provider_id; this only succeeds if the
  // submission is actually routed to the caller's provider.
  const { data: updatedRows, error } = await supabase
    .schema("crm")
    .from("enrolments")
    .update(update)
    .eq("submission_id", args.submissionId)
    .select("id");

  if (error) return { ok: false, error: error.message };
  if (!updatedRows || updatedRows.length === 0) {
    return { ok: false, error: "No enrolment row found, or you don't have access" };
  }

  // TODO (next session): write to audit.log_provider_action. The audit
  // schema isn't currently exposed via the Data API, so .rpc() can't reach
  // it directly. Either expose audit in the API settings + grant
  // service_role, or add a public-schema wrapper function. Required before
  // real-provider cutover per Clara's three gating conditions (Article 30
  // ROPA evidence).

  revalidatePath(`/provider/leads/${args.submissionId}`);
  revalidatePath("/provider/leads");
  revalidatePath("/provider");
  return { ok: true };
}
