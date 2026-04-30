"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type EnrolmentStatus =
  | "open"
  | "enrolled"
  | "presumed_enrolled"
  | "cannot_reach"
  | "lost";

export type LostReason =
  | "not_interested"
  | "wrong_course"
  | "funding_issue"
  | "other";

export interface MarkEnrolmentOutcomeInput {
  submissionId: number;
  status: EnrolmentStatus;
  notes?: string | null;
  lostReason?: LostReason | null;
  disputed?: boolean;
  disputedReason?: string | null;
}

export interface MarkEnrolmentOutcomeResult {
  ok: boolean;
  enrolmentId?: number;
  error?: string;
}

// Server Action: mark the enrolment outcome for a routed lead.
//
// Calls crm.upsert_enrolment_outcome (migration 0028) which validates the
// new taxonomy, persists disputes as flags, upserts crm.enrolments, and
// writes an audit row in one transaction. admin.is_admin() inside that
// function gates access — no need to re-check here.
export async function markEnrolmentOutcome(
  input: MarkEnrolmentOutcomeInput,
): Promise<MarkEnrolmentOutcomeResult> {
  const supabase = await createClient();

  const { data, error } = await supabase.schema("crm").rpc("upsert_enrolment_outcome", {
    p_submission_id:    input.submissionId,
    p_status:           input.status,
    p_notes:            input.notes ?? null,
    p_lost_reason:      input.lostReason ?? null,
    p_disputed:         input.disputed ?? false,
    p_disputed_reason:  input.disputedReason ?? null,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  // Fire-and-forget Brevo sync so SW_ENROL_STATUS catches up to the DB-side
  // change. crm.sync_leads_to_brevo (migration 0044) returns the pg_net
  // request_id immediately; the actual Brevo upsert runs async via the
  // admin-brevo-resync Edge Function. Failures land in leads.dead_letter,
  // never blocking the UI flow.
  await supabase.schema("crm").rpc("sync_leads_to_brevo", {
    p_submission_ids: [input.submissionId],
  });

  revalidatePath(`/leads/${input.submissionId}`);

  return { ok: true, enrolmentId: data as number };
}
