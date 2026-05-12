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
  type LeadType,
  type LostReason,
} from "@/lib/lead-status";

interface Args {
  submissionId: number;
  status: string;
  lostReason?: string | null;
  // Optional free-text note captured alongside the structured reason.
  // Provider portal exposes this for Lost / Cannot reach outcomes —
  // structured reason stays in lost_reason for analytics; this note
  // adds nuance ("learner says next year", "moved house"). Stored in
  // crm.enrolments.outcome_note (migration 0116).
  outcomeNote?: string | null;
}

const OUTCOME_NOTE_MAX = 500;

type Result = { ok: true } | { ok: false; error: string };

export async function markOutcomeAction(args: Args): Promise<Result> {
  if (!isLeadStatus(args.status)) {
    return { ok: false, error: `Invalid status: ${args.status}` };
  }
  const targetStatus = args.status as LeadStatus;

  // System statuses can't be set manually
  if (
    targetStatus === "presumed_enrolled"
    || targetStatus === "presumed_employer_signed"
    || targetStatus === "open"
  ) {
    return { ok: false, error: "That status can't be set manually." };
  }

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { ok: false, error: "Not signed in" };

  // Capture before-state for transition check + audit.
  const { data: existingRow, error: readError } = await supabase
    .schema("crm")
    .from("enrolments")
    .select("id, status, lost_reason, outcome_note")
    .eq("submission_id", args.submissionId)
    .maybeSingle();

  if (readError) return { ok: false, error: readError.message };
  if (!existingRow) {
    return { ok: false, error: "No enrolment row found, or you don't have access" };
  }

  // Lookup lead_type from the submission row so the transition rules pick
  // the right state machine (learner vs employer).
  const { data: subRow } = await supabase
    .schema("leads")
    .from("submissions")
    .select("lead_type")
    .eq("id", args.submissionId)
    .maybeSingle();
  const leadType: LeadType = (subRow?.lead_type ?? "learner") as LeadType;

  const fromStatus = existingRow.status as LeadStatus;
  if (!isAllowedTransition(fromStatus, targetStatus, leadType)) {
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

  // outcome_note is only persisted for terminal states. For Enrolled /
  // Meeting booked / attempt_X, ignore any incoming note string —
  // structured progression is the context for those, not a frozen note.
  // For Lost / Cannot reach we accept the note (trimmed, length-capped).
  const acceptsNote = targetStatus === "lost" || targetStatus === "cannot_reach";
  let newOutcomeNote: string | null = null;
  if (acceptsNote) {
    const raw = typeof args.outcomeNote === "string" ? args.outcomeNote.trim() : "";
    if (raw.length > OUTCOME_NOTE_MAX) {
      return { ok: false, error: `Note too long (max ${OUTCOME_NOTE_MAX} characters).` };
    }
    newOutcomeNote = raw.length > 0 ? raw : null;
  }

  const before = {
    status: existingRow.status,
    lost_reason: existingRow.lost_reason,
    outcome_note: existingRow.outcome_note ?? null,
  };
  const after = {
    status: targetStatus,
    lost_reason: newLostReason,
    outcome_note: newOutcomeNote,
  };

  if (
    before.status === after.status
    && before.lost_reason === after.lost_reason
    && before.outcome_note === after.outcome_note
  ) {
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
      outcome_note: newOutcomeNote,
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

  // Only revalidate the detail page the provider is sitting on. The leads
  // list and home will refresh on next nav OR via the realtime channel
  // catching the same UPDATE (debounced 600ms). Cutting the two extra
  // revalidates here removes ~500-800ms of redundant page rerender on
  // every outcome click — the click-to-paint latency Charlotte was
  // hitting was substantially this.
  revalidatePath(`/provider/leads/${args.submissionId}`);
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
// Status modes:
//   - "attempt_advance" — special. Each selected lead moves one step
//     down the attempt path (open→1, 1→2, 2→3). Anything past attempt_3
//     or already-terminal is skipped. Used when the provider has just
//     done a batch of calls and got no answer on each.
//   - "enrolment_meeting_booked" / "cannot_reach" / "lost" — direct
//     targets; validated per-lead via the state machine.
//   - "lost" additionally requires lostReason valid for each row's
//     from-state.
//
// "enrolled" is deliberately NOT supported in bulk — too consequential
// to be a multi-select action; goes through the per-lead outcome path
// where the provider sees the lead they're confirming.
export async function bulkMarkOutcomeAction(args: {
  submissionIds: number[];
  status: "attempt_advance" | "enrolment_meeting_booked" | "cannot_reach" | "lost";
  lostReason?: string | null;
}): Promise<{ ok: boolean; applied: number; skipped: number; error?: string }> {
  if (!Array.isArray(args.submissionIds) || args.submissionIds.length === 0) {
    return { ok: false, applied: 0, skipped: 0, error: "No leads selected" };
  }
  if (args.submissionIds.length > 200) {
    return { ok: false, applied: 0, skipped: 0, error: "Too many leads selected (max 200)" };
  }
  if (
    args.status !== "attempt_advance"
    && args.status !== "enrolment_meeting_booked"
    && args.status !== "cannot_reach"
    && args.status !== "lost"
  ) {
    return { ok: false, applied: 0, skipped: 0, error: `Bulk doesn't support status: ${args.status}` };
  }
  if (args.status === "lost") {
    if (!args.lostReason || !isLostReason(args.lostReason)) {
      return { ok: false, applied: 0, skipped: 0, error: "A lost reason is required for bulk lost" };
    }
  }

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return { ok: false, applied: 0, skipped: 0, error: "Not signed in" };
  }

  // RLS scopes the SELECT to the caller's own leads. Out-of-scope ids just
  // don't appear; never get UPDATEd because subsequent UPDATEs filter on
  // ids returned by this SELECT.
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

  // attempt_advance resolves per-lead. Non-advance modes share one target.
  const ATTEMPT_NEXT: Record<string, LeadStatus> = {
    open: "attempt_1_no_answer",
    attempt_1_no_answer: "attempt_2_no_answer",
    attempt_2_no_answer: "attempt_3_no_answer",
  };
  const sharedTarget: LeadStatus | null = args.status === "attempt_advance"
    ? null
    : (args.status as LeadStatus);
  const newLostReason: LostReason | null = args.status === "lost"
    ? (args.lostReason as LostReason)
    : null;
  const nowIso = new Date().toISOString();

  // Validate each row, group eligible rows by their (from → to) transition
  // so we can fire one UPDATE per group. For attempt_advance, this is at
  // most three groups (open→1, 1→2, 2→3). For shared-target modes, one
  // group. Skipped rows are counted but never written.
  type GroupKey = string; // `${from}|${to}`
  interface EligibleRow {
    enrolmentId: number;
    submissionId: number;
    fromStatus: LeadStatus;
    fromLostReason: string | null;
    toStatus: LeadStatus;
    toLostReason: LostReason | null;
  }
  const groups = new Map<GroupKey, EligibleRow[]>();
  let skipped = 0;

  for (const row of rows) {
    const fromStatus = row.status as LeadStatus;
    const targetStatus: LeadStatus | null = sharedTarget
      ?? ATTEMPT_NEXT[fromStatus]
      ?? null;
    if (!targetStatus) {
      skipped += 1;
      continue;
    }
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
    const key: GroupKey = `${fromStatus}|${targetStatus}`;
    const eligible: EligibleRow = {
      enrolmentId: row.id,
      submissionId: row.submission_id,
      fromStatus,
      fromLostReason: row.lost_reason,
      toStatus: targetStatus,
      toLostReason: newLostReason,
    };
    const existingGroup = groups.get(key);
    if (existingGroup) existingGroup.push(eligible);
    else groups.set(key, [eligible]);
  }

  // One UPDATE per (from, to) group. Guarded on `status = fromStatus`
  // so a concurrent state change between SELECT and UPDATE is a clean no-op
  // for that row (it falls out of the WHERE; the count delta surfaces as
  // skipped on the audit side because we only audit IDs that the SELECT
  // matched, not all attempted writes).
  let applied = 0;
  const auditEntries: Array<{
    target_table: string;
    target_id: string;
    before: { status: string; lost_reason: string | null };
    after: { status: LeadStatus; lost_reason: LostReason | null };
    context: { submission_id: number; bulk: true; bulk_mode: string };
  }> = [];

  for (const [, eligibleRows] of groups) {
    const ids = eligibleRows.map((r) => r.enrolmentId);
    const fromStatus = eligibleRows[0].fromStatus;
    const toStatus = eligibleRows[0].toStatus;
    const toLostReason = eligibleRows[0].toLostReason;

    const { error: updErr, count } = await supabase
      .schema("crm")
      .from("enrolments")
      .update({
        status: toStatus,
        lost_reason: toLostReason,
        status_updated_at: nowIso,
        updated_at: nowIso,
        callback_requested_at: null,
        callback_requested_by: null,
      }, { count: "exact" })
      .in("id", ids)
      .eq("status", fromStatus);

    if (updErr) {
      // Treat the whole group as skipped on the audit side. The UPDATE
      // could partially fail at the RLS level but supabase-js doesn't
      // report partial results — conservative is to not log audit for
      // a failed group.
      skipped += ids.length;
      continue;
    }

    // `count` reflects rows actually updated (may be < ids.length if a
    // concurrent change moved a row off `status = fromStatus`). We still
    // audit only the rows we *intended* to update — the user-perceived
    // applied count matches the click intent. If count < ids.length we
    // add the difference to skipped so the response is accurate.
    if (typeof count === "number" && count < ids.length) {
      skipped += ids.length - count;
    }
    const actuallyApplied = typeof count === "number" ? count : ids.length;
    applied += actuallyApplied;

    for (const row of eligibleRows) {
      auditEntries.push({
        target_table: "crm.enrolments",
        target_id: String(row.enrolmentId),
        before: { status: row.fromStatus, lost_reason: row.fromLostReason },
        after: { status: row.toStatus, lost_reason: row.toLostReason },
        context: {
          submission_id: row.submissionId,
          bulk: true,
          bulk_mode: args.status,
        },
      });
    }
  }

  // Single audit RPC for the entire batch.
  if (auditEntries.length > 0) {
    const { error: auditErr } = await supabase.rpc("log_provider_action_bulk_v1", {
      p_action: "mark_outcome_bulk",
      p_entries: auditEntries,
    });
    if (auditErr) {
      // The data writes already landed; audit failed. Surface so the
      // operator can see the discrepancy and decide whether to replay
      // the audit out-of-band.
      return {
        ok: false,
        applied,
        skipped,
        error: `Outcomes saved but audit write failed: ${auditErr.message}`,
      };
    }
  }

  // Submissions the caller doesn't own never appeared in the SELECT —
  // count them as skipped so the UI total matches the click count.
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
