"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type EnrolmentOutcome =
  | "enrolled"
  | "not_enrolled"
  | "presumed_enrolled"
  | "disputed";

export interface MarkEnrolmentOutcomeInput {
  submissionId: number;
  outcome: EnrolmentOutcome;
  notes?: string | null;
}

export interface MarkEnrolmentOutcomeResult {
  ok: boolean;
  enrolmentId?: number;
  error?: string;
}

// Server Action: mark the enrolment outcome for a routed lead.
//
// Calls crm.upsert_enrolment_outcome (migration 0022) which validates,
// upserts crm.enrolments, and writes an audit row in one transaction.
// admin.is_admin() inside that function gates access — no need to re-check
// here.
//
// On success, revalidates the lead detail page so the new state shows
// without a hard refresh.
export async function markEnrolmentOutcome(
  input: MarkEnrolmentOutcomeInput,
): Promise<MarkEnrolmentOutcomeResult> {
  const supabase = await createClient();

  const { data, error } = await supabase.schema("crm").rpc("upsert_enrolment_outcome", {
    p_submission_id: input.submissionId,
    p_status: input.outcome,
    p_notes: input.notes ?? null,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath(`/leads/${input.submissionId}`);

  return { ok: true, enrolmentId: data as number };
}
