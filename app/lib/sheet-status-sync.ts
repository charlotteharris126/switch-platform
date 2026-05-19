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
//   - Every non-`open` portal status pushes a corresponding sheet label so
//     the sheet's Status column tracks the portal in real time. Providers
//     who still work in the sheet see the same granular state Charlotte /
//     Freya see in the portal (Calling, Meeting booked, In progress, etc.).
//   - `open` is the initial state set at routing and never re-pushed from
//     here — the routing function writes it directly when the row first
//     lands on the sheet, and there's no portal action that transitions
//     anything back to open.
//   - Before 2026-05-19 sub-states (attempt_*, enrolment_meeting_booked,
//     in_progress) were deliberately NOT pushed, on the theory that the
//     sheet carried the high-level state only. The daily reconcile cron's
//     projection (statusToSheetLabel in _shared/sheet-status.ts) disagreed
//     with that — it projected DB through to Calling / Meeting booked and
//     flagged the gap as drift on every attempt click. Aligning both
//     directions stops the loop. Drop-down on each provider sheet was
//     extended on 2026-05-19 to accept the new labels.
//   - Major transitions (cannot_reach, enrolled, presumed_enrolled, lost,
//     engaged, signed, not_signed, presumed_employer_signed) push the
//     same way via the provider's sheet_webhook_url with
//     mode='update_by_submission_id'.
//   - Best-effort. A sheet-side failure logs to console but doesn't roll
//     back the DB status change. Daily reconcile cron is the safety net.

import { createAdminClient } from "@/lib/supabase/admin";
import type { LeadStatus } from "@/lib/lead-status";

// Maps portal status → sheet Status cell label. NULL means "don't push"
// (only `open` is null — set once at routing, never re-pushed from here).
const STATUS_TO_SHEET_LABEL: Record<LeadStatus, string | null> = {
  // Routing-set, never re-pushed from portal
  open: null,
  // Learner sub-states
  attempt_1_no_answer: "Calling",
  attempt_2_no_answer: "Calling",
  attempt_3_no_answer: "Calling",
  enrolment_meeting_booked: "Meeting booked",
  // Learner terminal / major
  enrolled: "Enrolled",
  presumed_enrolled: "Presumed enrolled",
  lost: "Lost",
  cannot_reach: "Cannot reach",
  // Employer states
  engaged: "Engaged",
  in_progress: "In progress",
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
