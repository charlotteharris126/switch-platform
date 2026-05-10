"use server";

// Server Action. provider marks an outcome on one of their leads.
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
// public-schema wrapper over audit.log_provider_action. the audit schema
// itself is not exposed in the Data API). Surfaces audit failures to the
// caller rather than swallowing, so a failed write is visible. Atomic
// (UPDATE + audit in one transaction) is a pending refinement.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
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
  // Marking any new outcome clears the admin callback flag. "the
  // provider acted, the nudge is resolved". The flag's audit trail
  // lives in lead_notes (the original admin note that raised it
  // stays in history regardless).
  const { error: updateError } = await supabase
    .schema("crm")
    .from("enrolments")
    .update({
      status: targetStatus,
      lost_reason: newLostReason,
      status_updated_at: nowIso,
      updated_at: nowIso,
      callback_requested_at: null,
      callback_requested_by: null,
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

const NOTE_MAX = 5000;

export async function addLeadNoteAction(args: {
  submissionId: number;
  body: string;
}): Promise<Result> {
  if (typeof args.body !== "string") {
    return { ok: false, error: "Note must be text." };
  }
  const body = args.body.trim();
  if (body.length === 0) return { ok: false, error: "Note can't be empty." };
  if (body.length > NOTE_MAX) {
    return { ok: false, error: `Note too long (max ${NOTE_MAX} characters).` };
  }

  const supabase = await createClient();
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) return { ok: false, error: "Not signed in" };

  // Resolve caller → provider_user_id + provider_id. Service-role client
  // because crm.provider_users RLS scopes via auth.uid() but we only
  // need our own row. RLS on crm.lead_notes will validate the insert.
  const admin = createAdminClient();
  const { data: pu, error: puErr } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, provider_id, display_name, contact_email")
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle<{ id: number; provider_id: string; display_name: string | null; contact_email: string }>();

  if (puErr) return { ok: false, error: puErr.message };
  if (!pu) return { ok: false, error: "Active provider user not found" };

  // INSERT via authenticated client so RLS validates the WITH CHECK
  // (provider_id = caller's, submission_id is theirs).
  const { data: inserted, error: insErr } = await supabase
    .schema("crm")
    .from("lead_notes")
    .insert({
      submission_id: args.submissionId,
      provider_id: pu.provider_id,
      provider_user_id: pu.id,
      body,
      author_role: "provider",
      author_user_id: user.id,
      author_display_name: pu.display_name ?? pu.contact_email,
    })
    .select("id")
    .maybeSingle<{ id: number }>();

  if (insErr) return { ok: false, error: insErr.message };
  if (!inserted) return { ok: false, error: "Insert returned no row (RLS may have rejected)" };

  const { error: auditError } = await supabase.rpc("log_provider_action_v1", {
    p_action: "add_note",
    p_target_table: "crm.lead_notes",
    p_target_id: String(inserted.id),
    p_before: null,
    p_after: { body },
    p_context: { submission_id: args.submissionId },
  });

  if (auditError) {
    return { ok: false, error: `Saved but audit write failed: ${auditError.message}` };
  }

  revalidatePath(`/provider/leads/${args.submissionId}`);
  return { ok: true };
}

// Bulk-mark outcomes across multiple submission IDs at once. Used by the
// checkbox-based selection on /provider/leads. Each row is processed
// independently — invalid transitions are skipped and counted, not
// errored. Audit logs one row per successful update.
//
// Currently supports cannot_reach (no extra fields) and lost (with
// shared lost_reason). Other transitions stay one-by-one because the
// state machine is tighter on those (e.g. attempt_2 from open is wrong;
// attempt_1 from already-attempt_1 is a no-op).
export async function bulkMarkOutcomeAction(args: {
  submissionIds: number[];
  status: "cannot_reach" | "lost";
  lostReason?: string | null;
}): Promise<{ ok: boolean; applied: number; skipped: number; error?: string }> {
  if (!Array.isArray(args.submissionIds) || args.submissionIds.length === 0) {
    return { ok: false, applied: 0, skipped: 0, error: "No leads selected" };
  }
  if (args.submissionIds.length > 200) {
    return { ok: false, applied: 0, skipped: 0, error: "Too many leads selected (max 200)" };
  }
  if (args.status !== "cannot_reach" && args.status !== "lost") {
    return { ok: false, applied: 0, skipped: 0, error: `Bulk doesn't support status: ${args.status}` };
  }
  if (args.status === "lost") {
    if (!args.lostReason || !isLostReason(args.lostReason)) {
      return { ok: false, applied: 0, skipped: 0, error: "A lost reason is required for bulk lost" };
    }
  }

  const supabase = await createClient();
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session?.user) {
    return { ok: false, applied: 0, skipped: 0, error: "Not signed in" };
  }

  // RLS scopes the SELECT to the caller's own leads. Out-of-scope ids just
  // don't appear; out-of-scope ids never get UPDATEd because the .in()
  // filter on subsequent updates is a subset of returned ids.
  const { data: existing, error: readError } = await supabase
    .schema("crm")
    .from("enrolments")
    .select("id, submission_id, status, lost_reason")
    .in("submission_id", args.submissionIds);
  if (readError) return { ok: false, applied: 0, skipped: 0, error: readError.message };
  const rows = (existing ?? []) as Array<{
    id: number;
    submission_id: number;
    status: string;
    lost_reason: string | null;
  }>;

  const targetStatus = args.status as LeadStatus;
  const newLostReason: LostReason | null = args.status === "lost" ? (args.lostReason as LostReason) : null;
  const nowIso = new Date().toISOString();

  let applied = 0;
  let skipped = 0;

  for (const row of rows) {
    const fromStatus = row.status as LeadStatus;
    if (!isAllowedTransition(fromStatus, targetStatus)) {
      skipped += 1;
      continue;
    }
    if (args.status === "lost" && !lostReasonsFor(fromStatus).includes(args.lostReason as LostReason)) {
      skipped += 1;
      continue;
    }
    if (
      row.status === targetStatus &&
      (row.lost_reason ?? null) === (newLostReason ?? null)
    ) {
      skipped += 1;
      continue;
    }

    const before = { status: row.status, lost_reason: row.lost_reason };
    const after = { status: targetStatus, lost_reason: newLostReason };

    const { error: updErr } = await supabase
      .schema("crm")
      .from("enrolments")
      .update({
        status: targetStatus,
        lost_reason: newLostReason,
        status_updated_at: nowIso,
        updated_at: nowIso,
        callback_requested_at: null,
        callback_requested_by: null,
      })
      .eq("id", row.id);
    if (updErr) {
      skipped += 1;
      continue;
    }

    await supabase.rpc("log_provider_action_v1", {
      p_action: "mark_outcome_bulk",
      p_target_table: "crm.enrolments",
      p_target_id: String(row.id),
      p_before: before,
      p_after: after,
      p_context: { submission_id: row.submission_id, bulk: true },
    });

    applied += 1;
  }

  // Skipped count includes both "transition not allowed" and submissions the
  // caller doesn't own (those never appeared in the SELECT in the first place).
  const totalRequested = args.submissionIds.length;
  const notFound = totalRequested - rows.length;
  skipped += notFound;

  revalidatePath("/provider/leads");
  revalidatePath("/provider");
  return { ok: true, applied, skipped };
}

// Called when the provider opens a lead detail page. marks any unread
// admin notes on that lead as read. Idempotent: a no-op if there's
// nothing unread. RLS scopes the UPDATE to the provider's own leads.
export async function markAdminNotesReadAction(args: {
  submissionId: number;
}): Promise<Result> {
  const supabase = await createClient();
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session?.user) return { ok: false, error: "Not signed in" };

  const { error } = await supabase
    .schema("crm")
    .from("lead_notes")
    .update({ read_by_provider_at: new Date().toISOString() })
    .eq("submission_id", args.submissionId)
    .eq("author_role", "admin")
    .is("read_by_provider_at", null);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
