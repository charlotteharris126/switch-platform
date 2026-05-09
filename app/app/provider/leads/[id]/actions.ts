"use server";

// Server Action — provider marks an outcome on one of their leads.
//
// Auth: the authenticated client (cookie session) is used. RLS policies
// from migration 0096 limit which crm.enrolments rows the provider can
// UPDATE; we don't repeat those checks here.
//
// Validation:
//   - Status must be a known LeadStatus
//   - The transition (from -> to) must be allowed by the state machine in
//     lib/lead-status.ts. Defence-in-depth: the UI only shows valid
//     options, but a malicious / stale tab could still POST anything.
//   - Lost reasons are validated against the lostReasonsFor(from) set.
//
// Audit: every change writes through public.log_provider_action_v1 (the
// public-schema wrapper over audit.log_provider_action — the audit schema
// itself is not exposed in the Data API). Surfaces audit failures to the
// caller rather than swallowing, so a failed write is visible. Atomic
// (UPDATE + audit in one transaction) is a pending refinement.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  isAllowedTransition,
  isLeadStatus,
  isLostReason,
  lostReasonsFor,
  STATUS_LABEL,
  type LeadStatus,
  type LostReason,
} from "@/lib/lead-status";

interface Args {
  submissionId: number;
  status: string;
  lostReason?: string | null;
}

type Result = { ok: true } | { ok: false; error: string };

export async function markOutcomeAction(args: Args): Promise<Result> {
  if (!isLeadStatus(args.status)) {
    return { ok: false, error: `Invalid status: ${args.status}` };
  }
  const targetStatus = args.status as LeadStatus;

  // System statuses can't be set manually
  if (targetStatus === "presumed_enrolled" || targetStatus === "open") {
    return { ok: false, error: "That status can't be set manually." };
  }

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { ok: false, error: "Not signed in" };

  // Capture before-state for transition check + audit.
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

  const fromStatus = existingRow.status as LeadStatus;
  if (!isAllowedTransition(fromStatus, targetStatus)) {
    return {
      ok: false,
      error: `Can't move from "${STATUS_LABEL[fromStatus]}" to "${STATUS_LABEL[targetStatus]}".`,
    };
  }

  let newLostReason: LostReason | null = null;
  if (targetStatus === "lost") {
    if (!args.lostReason || !isLostReason(args.lostReason)) {
      return { ok: false, error: "A lost reason is required." };
    }
    if (!lostReasonsFor(fromStatus).includes(args.lostReason)) {
      return {
        ok: false,
        error: `That lost reason isn't valid from "${STATUS_LABEL[fromStatus]}".`,
      };
    }
    newLostReason = args.lostReason;
  }

  const before = { status: existingRow.status, lost_reason: existingRow.lost_reason };
  const after = { status: targetStatus, lost_reason: newLostReason };

  if (before.status === after.status && before.lost_reason === after.lost_reason) {
    return { ok: true };
  }

  const nowIso = new Date().toISOString();
  const { error: updateError } = await supabase
    .schema("crm")
    .from("enrolments")
    .update({
      status: targetStatus,
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

const NOTES_MAX = 5000;

export async function saveLeadNotesAction(args: {
  submissionId: number;
  notes: string;
}): Promise<Result> {
  if (typeof args.notes !== "string") {
    return { ok: false, error: "Notes must be text." };
  }
  if (args.notes.length > NOTES_MAX) {
    return { ok: false, error: `Notes too long (max ${NOTES_MAX} characters).` };
  }

  const trimmed = args.notes.trim().length === 0 ? null : args.notes;

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { ok: false, error: "Not signed in" };

  const { data: existing, error: readError } = await supabase
    .schema("crm")
    .from("enrolments")
    .select("id, notes")
    .eq("submission_id", args.submissionId)
    .maybeSingle();

  if (readError) return { ok: false, error: readError.message };
  if (!existing) {
    return { ok: false, error: "No enrolment row found, or you don't have access" };
  }

  const before = existing.notes ?? null;
  if (before === trimmed) {
    return { ok: true };
  }

  const { error: updateError } = await supabase
    .schema("crm")
    .from("enrolments")
    .update({ notes: trimmed, updated_at: new Date().toISOString() })
    .eq("id", existing.id);

  if (updateError) return { ok: false, error: updateError.message };

  const { error: auditError } = await supabase.rpc("log_provider_action_v1", {
    p_action: "save_notes",
    p_target_table: "crm.enrolments",
    p_target_id: String(existing.id),
    p_before: { notes: before },
    p_after: { notes: trimmed },
    p_context: { submission_id: args.submissionId },
  });

  if (auditError) {
    return { ok: false, error: `Notes saved but audit write failed: ${auditError.message}` };
  }

  revalidatePath(`/provider/leads/${args.submissionId}`);
  return { ok: true };
}
