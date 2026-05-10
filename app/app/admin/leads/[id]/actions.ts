"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/auth/allowlist";

// Tag (or untag) a submission as an owner test. Writes the same shape as the
// auto-DQ path in _shared/ingest.ts so a manually-tagged row is indistinguishable
// from one caught at ingest. Only admins can call this (RLS gate, migration 0072).
export async function markOwnerTestSubmission(
  submissionId: number,
  markAsTest: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();

  const update = markAsTest
    ? { is_dq: true, dq_reason: "owner_test_submission", archived_at: new Date().toISOString() }
    : { is_dq: false, dq_reason: null, archived_at: null };

  const { error } = await supabase
    .schema("leads")
    .from("submissions")
    .update(update)
    .eq("id", submissionId);

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/leads/${submissionId}`);
  revalidatePath("/leads");
  return { ok: true };
}


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
  | "cancelled"
  | "withdrew_after_enrolment"
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

// ============================================================================
// Admin notes on a routed lead — appears in the provider's notes log.
// Optional callback flag pins the lead to the top of their list, fires a
// utility email, and counts in their nav badge / sidebar tile until they
// mark any new outcome on the lead (which clears the flag automatically).
// ============================================================================

const ADMIN_NOTE_MAX = 5000;

export interface AddAdminLeadNoteInput {
  submissionId: number;
  body: string;
  /** Raise the callback flag on the lead's enrolment + fire the utility email. */
  raiseCallback?: boolean;
}

async function ensureAdminCaller(): Promise<
  | { ok: true; user: { id: string; email: string }; displayName: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient();
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user || !user.email) return { ok: false, error: "Not signed in" };
  if (!isAdmin(user.email)) return { ok: false, error: "Admin only" };
  const displayName = (user.user_metadata?.display_name as string | undefined)
    ?? user.email.split("@")[0]
    ?? "Switchable";
  return { ok: true, user: { id: user.id, email: user.email }, displayName };
}

export async function addAdminLeadNoteAction(
  input: AddAdminLeadNoteInput,
): Promise<{ ok: boolean; noteId?: number; callbackRaised?: boolean; error?: string }> {
  if (typeof input.body !== "string") return { ok: false, error: "Note must be text." };
  const body = input.body.trim();
  if (body.length === 0) return { ok: false, error: "Note can't be empty." };
  if (body.length > ADMIN_NOTE_MAX) {
    return { ok: false, error: `Note too long (max ${ADMIN_NOTE_MAX} characters).` };
  }

  const ctx = await ensureAdminCaller();
  if (!ctx.ok) return ctx;

  const admin = createAdminClient();

  // Resolve the lead's primary_routed_to to set provider_id on the note row.
  const { data: sub, error: subErr } = await admin
    .schema("leads")
    .from("submissions")
    .select("id, first_name, last_name, primary_routed_to")
    .eq("id", input.submissionId)
    .maybeSingle<{ id: number; first_name: string | null; last_name: string | null; primary_routed_to: string | null }>();

  if (subErr) return { ok: false, error: subErr.message };
  if (!sub) return { ok: false, error: "Lead not found" };
  if (!sub.primary_routed_to) {
    return { ok: false, error: "Lead has no routed provider yet — admin notes only work on routed leads." };
  }

  const nowIso = new Date().toISOString();

  // INSERT via admin client (admin_all_lead_notes RLS gates by admin.is_admin()
  // which doesn't apply when running with service_role, so the policy isn't
  // the gate — but service_role + 0109 functions_all policy + ensureAdminCaller
  // server-side check is the trust boundary).
  const { data: inserted, error: insErr } = await admin
    .schema("crm")
    .from("lead_notes")
    .insert({
      submission_id: input.submissionId,
      provider_id: sub.primary_routed_to,
      provider_user_id: null,
      author_role: "admin",
      author_user_id: ctx.user.id,
      author_display_name: ctx.displayName,
      body,
    })
    .select("id")
    .maybeSingle<{ id: number }>();

  if (insErr) return { ok: false, error: insErr.message };
  if (!inserted) return { ok: false, error: "Insert returned no row" };

  let callbackRaised = false;
  if (input.raiseCallback) {
    const { error: flagErr } = await admin
      .schema("crm")
      .from("enrolments")
      .update({
        callback_requested_at: nowIso,
        callback_requested_by: ctx.user.id,
        updated_at: nowIso,
      })
      .eq("submission_id", input.submissionId);
    if (flagErr) return { ok: false, error: `Note saved but flag-raise failed: ${flagErr.message}` };
    callbackRaised = true;

    // Fire the utility email — best-effort, no-ops if Brevo env missing.
    void fireProviderCallbackEmail({
      providerId: sub.primary_routed_to,
      submissionId: input.submissionId,
      noteBody: body,
    }).catch(() => {
      // swallowed; helper logs internally.
    });
  }

  revalidatePath(`/admin/leads/${input.submissionId}`);
  revalidatePath(`/provider/leads/${input.submissionId}`);
  revalidatePath("/provider/leads");
  revalidatePath("/provider");

  return { ok: true, noteId: inserted.id, callbackRaised };
}

export async function clearCallbackFlagAction(args: {
  submissionId: number;
}): Promise<{ ok: boolean; error?: string }> {
  const ctx = await ensureAdminCaller();
  if (!ctx.ok) return ctx;

  const admin = createAdminClient();
  const { error } = await admin
    .schema("crm")
    .from("enrolments")
    .update({
      callback_requested_at: null,
      callback_requested_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq("submission_id", args.submissionId);

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/admin/leads/${args.submissionId}`);
  revalidatePath(`/provider/leads/${args.submissionId}`);
  revalidatePath("/provider/leads");
  revalidatePath("/provider");
  return { ok: true };
}

// Best-effort utility email to the provider when a callback flag is raised.
// Code-composed (no Brevo template needed), sent from "Switchable" so it
// reads as account-based rather than personal mail. PII-free: lead id +
// portal deep link only — full note text stays inside the portal.
//
// Best-effort: BREVO_API_KEY missing → silent no-op. Failures log + return.
async function fireProviderCallbackEmail(args: {
  providerId: string;
  submissionId: number;
  noteBody: string;
}): Promise<void> {
  const admin = createAdminClient();
  const { data: providerUsers } = await admin
    .schema("crm")
    .from("provider_users")
    .select("contact_email, display_name")
    .eq("provider_id", args.providerId)
    .eq("status", "active");

  if (!providerUsers || providerUsers.length === 0) return;

  const portalUrl = `https://app.switchleads.co.uk/leads/${args.submissionId}`;
  const subject = `Lead #${args.submissionId} update from Switchable`;

  // HTML-escape the note body — admin-typed, but treat as untrusted on the
  // way out (defence-in-depth against future surfaces that render this).
  const escapedNote = escapeHtml(args.noteBody).replace(/\n/g, "<br>");

  // Inline-styled HTML so it renders consistently across mail clients.
  const html = `
<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0f172a; line-height: 1.5; padding: 16px; max-width: 560px;">
  <p>Hi,</p>
  <p>Lead <strong>#${args.submissionId}</strong> has been in touch.</p>
  <div style="margin: 16px 0; padding: 14px 16px; background: #fef3c7; border: 1px solid #fcd34d; border-radius: 6px;">
    <p style="margin: 0 0 4px 0; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #92400e;">Note from Switchable</p>
    <p style="margin: 0; color: #78350f; white-space: pre-wrap;">${escapedNote}</p>
  </div>
  <p style="margin: 24px 0;">
    <a href="${portalUrl}" style="display: inline-block; padding: 10px 18px; background: #0f172a; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">
      Open the lead in your portal
    </a>
  </p>
  <p>Open it to follow up.</p>
  <p style="margin-top: 32px; color: #64748b;">Switchable</p>
</body></html>
  `.trim();

  // Lazy import to keep the action's bundle slim.
  const { sendTransactional } = await import("@/lib/email/send-transactional");
  for (const pu of providerUsers as Array<{ contact_email: string; display_name: string | null }>) {
    await sendTransactional({
      to: { email: pu.contact_email, name: pu.display_name ?? pu.contact_email },
      sender: {
        email: process.env.BREVO_SENDER_EMAIL ?? "hello@switchable.org.uk",
        name: "Switchable",
      },
      subject,
      htmlContent: html,
    });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
