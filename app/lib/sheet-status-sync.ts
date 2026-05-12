// Portal → sheet status sync. Fired fire-and-forget from server actions
// after a successful crm.enrolments status change, so the provider's
// Google Sheet's Status column reflects the portal-set state without
// waiting for the daily reconcile cron.
//
// Why this exists:
//   Until the portal launched, the provider sheet was the primary work
//   surface and sheet-edit-mirror Edge Function pushed sheet → DB.
//   Post-portal-cutover, providers start working primarily in the
//   portal, so the reverse direction (DB → sheet) needs to fire on
//   every outcome marking. Without this, the sheet shows stale status
//   and Jane / Andy see drift between portal and sheet.
//
// Design:
//   - Sub-states (attempt_1/2/3_no_answer, learner enrolment_meeting_booked,
//     employer in_progress) DO NOT push to the sheet. The sheet's Status
//     column carries the HIGH-LEVEL state only — attempts live in the
//     portal. While the lead is in attempt-phase the sheet shows "Open"
//     and the portal carries the granular counter.
//   - Major transitions (cannot_reach, enrolled, presumed_enrolled, lost,
//     engaged, signed, not_signed, presumed_employer_signed) push to the
//     sheet via the provider's sheet_webhook_url with mode='update_by_submission_id'.
//   - Best-effort. A sheet-side failure logs to console but doesn't roll
//     back the DB status change. Daily reconcile cron is the safety net.

import { createAdminClient } from "@/lib/supabase/admin";
import type { LeadStatus } from "@/lib/lead-status";

// Maps portal status → sheet Status cell label. NULL means "don't push"
// (sub-state, sheet stays at its current high-level value).
const STATUS_TO_SHEET_LABEL: Record<LeadStatus, string | null> = {
  // Learner sub-states
  open: null,
  attempt_1_no_answer: null,
  attempt_2_no_answer: null,
  attempt_3_no_answer: null,
  enrolment_meeting_booked: null,  // sub-state for learner sheets
  // Learner terminal / major
  enrolled: "Enrolled",
  presumed_enrolled: "Presumed enrolled",
  lost: "Lost",
  cannot_reach: "Cannot reach",
  // Employer sub-states
  in_progress: null,                // sub-state — sheet stays at Engaged
  // Employer major
  engaged: "Engaged",
  signed: "Signed",
  not_signed: "Not signed",
  presumed_employer_signed: "Presumed signed",
};

interface SyncArgs {
  submissionId: number;
  providerId: string;
  newStatus: LeadStatus;
}

export async function pushSheetStatus(args: SyncArgs): Promise<void> {
  const sheetLabel = STATUS_TO_SHEET_LABEL[args.newStatus];
  if (sheetLabel === null || sheetLabel === undefined) {
    // Sub-state — don't push, sheet stays as-is.
    return;
  }

  const admin = createAdminClient();
  const { data: provider } = await admin
    .schema("crm")
    .from("providers")
    .select("sheet_webhook_url")
    .eq("provider_id", args.providerId)
    .maybeSingle<{ sheet_webhook_url: string | null }>();

  if (!provider?.sheet_webhook_url) {
    // Provider hasn't wired their sheet yet — skip silently. Reconcile
    // cron will catch up once they do.
    return;
  }

  const token = process.env.SHEETS_APPEND_TOKEN;
  if (!token) {
    console.warn("SHEETS_APPEND_TOKEN not set; skipping portal→sheet sync");
    return;
  }

  try {
    const res = await fetch(provider.sheet_webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        mode: "update_by_submission_id",
        submission_id: args.submissionId,
        fields: {
          Status: sheetLabel,
        },
      }),
    });
    if (!res.ok) {
      console.warn(
        `portal→sheet sync failed: submission=${args.submissionId} status=${args.newStatus} sheet=${sheetLabel} http=${res.status}`,
      );
    }
  } catch (err) {
    console.warn(
      `portal→sheet sync threw: submission=${args.submissionId} status=${args.newStatus}`,
      err,
    );
  }
}
