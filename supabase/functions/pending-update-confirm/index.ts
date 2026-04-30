// Edge Function: pending-update-confirm
//
// Handles the Approve / Reject / Override clicks from AI suggestion emails
// sent by sheet-edit-mirror (Channel B). Same UX pattern as routing-confirm:
// click a signed link in an email, get a confirmation page back.
//
// URL shapes:
//   GET ?token=<approve-token>            → applies suggested status, confirms
//   GET ?token=<reject-token>             → marks rejected, confirms
//   GET ?token=<override-token>           → renders status-picker page
//   GET ?token=<override-token>&status=X  → applies chosen status, confirms
//
// Token verification: HMAC-signed via _shared/pending-update-token.ts. The
// payload binds (pending_update_id, action, expires_at). Token alone proves
// the recipient has the email; idempotency is enforced by checking
// crm.pending_updates.status (must be 'pending' to apply).
//
// Auth: token only. Deploy with --no-verify-jwt; verify_jwt=false in
// config.toml.
//
// Related:
//   - platform/docs/sheet-mirror-scoping.md (design)
//   - platform/supabase/functions/sheet-edit-mirror (caller — generates tokens)
//   - platform/supabase/functions/_shared/pending-update-token.ts (HMAC helpers)

import postgres from "npm:postgres@3";
import { verifyPendingUpdateToken } from "../_shared/pending-update-token.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
const PENDING_UPDATE_SECRET = Deno.env.get("PENDING_UPDATE_SECRET");

if (!DATABASE_URL) throw new Error("SUPABASE_DB_URL is not set.");
// PENDING_UPDATE_SECRET is checked at request time below — function deploys
// cleanly during Phase 1 even when Channel B (which needs the secret) is
// not yet activated. Without the secret, every request returns a soft 503.

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

const VALID_STATUSES = ["contacted", "enrolled", "not_enrolled", "disputed"];

interface PendingRow {
  id: number;
  enrolment_id: number;
  status: string;
  current_status: string;
  suggested_status: string;
  ai_summary: string | null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (!PENDING_UPDATE_SECRET) {
    return htmlPage(
      "Channel B not yet activated",
      "AI suggestion approval links are not active yet. This Edge Function exists but is awaiting Phase 2 configuration (PENDING_UPDATE_SECRET).",
      503,
    );
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  if (!token) {
    return htmlPage("Missing token", "The confirmation link is malformed. Please return to your email and click the original link.", 400);
  }

  const verify = await verifyPendingUpdateToken(token, PENDING_UPDATE_SECRET);
  if (!verify.ok || !verify.payload) {
    const reason = verify.error ?? "invalid";
    const message = reason === "expired"
      ? "This link has expired. AI suggestion links are valid for 7 days. Open the admin dashboard to resolve the suggestion manually."
      : "This link couldn't be verified. It may have been edited or copied incorrectly.";
    return htmlPage("Link not valid", message, 400);
  }

  const { pending_update_id, action } = verify.payload;

  // Load the pending row
  const [pending] = await sql<Array<PendingRow>>`
    SELECT id, enrolment_id, status, current_status, suggested_status, ai_summary
    FROM crm.pending_updates
    WHERE id = ${pending_update_id}
    LIMIT 1
  `;
  if (!pending) {
    return htmlPage("Suggestion not found", "The AI suggestion this link refers to no longer exists.", 404);
  }
  if (pending.status !== "pending") {
    return htmlPage(
      "Already resolved",
      `This suggestion has already been ${pending.status}. No further action needed.`,
      200,
    );
  }

  if (action === "approve") {
    return await applyApprove(pending);
  }
  if (action === "reject") {
    return await applyReject(pending);
  }
  if (action === "override") {
    const chosen = url.searchParams.get("status");
    if (!chosen) {
      return renderOverridePicker(pending, token);
    }
    if (!VALID_STATUSES.includes(chosen)) {
      return htmlPage("Invalid status", `"${chosen}" is not a valid enrolment status.`, 400);
    }
    return await applyOverride(pending, chosen);
  }

  return htmlPage("Unknown action", "The link's action is not recognised.", 400);
});

// ---- Apply paths ----

async function applyApprove(pending: PendingRow): Promise<Response> {
  return await applyStatusChange(pending, pending.suggested_status, "approved", "ai_approved");
}

async function applyReject(pending: PendingRow): Promise<Response> {
  await sql`
    UPDATE crm.pending_updates
    SET status = 'rejected',
        resolved_at = now(),
        resolved_by = 'owner'
    WHERE id = ${pending.id} AND status = 'pending'
  `;
  await logResolution(pending, "ai_rejected", null);
  return htmlPage(
    "Rejected",
    `The AI suggestion (${pending.current_status} → ${pending.suggested_status}) was rejected. The lead's status remains <strong>${pending.current_status}</strong>.`,
    200,
  );
}

async function applyOverride(pending: PendingRow, chosen: string): Promise<Response> {
  return await applyStatusChange(pending, chosen, "overridden", "ai_overridden");
}

async function applyStatusChange(
  pending: PendingRow,
  newStatus: string,
  pendingResolution: "approved" | "overridden",
  auditAction: string,
): Promise<Response> {
  // Check current enrolment state hasn't drifted in a way that blocks the transition
  const [currentRow] = await sql<Array<{ status: string }>>`
    SELECT status FROM crm.enrolments WHERE id = ${pending.enrolment_id} LIMIT 1
  `;
  if (!currentRow) {
    return htmlPage(
      "Enrolment not found",
      "The enrolment this suggestion refers to no longer exists.",
      404,
    );
  }
  const currentStatus = currentRow.status;
  if (currentStatus === "billed" || currentStatus === "paid") {
    return htmlPage(
      "Already billed",
      `The enrolment is now <strong>${currentStatus}</strong>. Status changes after billing should go through the dispute process.`,
      409,
    );
  }
  if (currentStatus === newStatus) {
    // No-op — record the resolution but don't fire UPDATE
    await sql`
      UPDATE crm.pending_updates
      SET status = ${pendingResolution},
          override_status = ${pendingResolution === "overridden" ? newStatus : null},
          resolved_at = now(),
          resolved_by = 'owner',
          applied_at = now()
      WHERE id = ${pending.id} AND status = 'pending'
    `;
    return htmlPage(
      "Already at this status",
      `The enrolment is already <strong>${newStatus}</strong>. Nothing to change. The suggestion is recorded as ${pendingResolution}.`,
      200,
    );
  }

  // Apply
  await sql`
    UPDATE crm.enrolments
    SET status = ${newStatus},
        status_updated_at = now(),
        updated_at = now()
    WHERE id = ${pending.enrolment_id}
  `;
  if (newStatus === "disputed") {
    await sql`
      INSERT INTO crm.disputes (enrolment_id, raised_by, reason)
      VALUES (
        ${pending.enrolment_id},
        'owner',
        ${`AI ${pendingResolution} via sheet update: ${pending.ai_summary ?? "no summary"}`}
      )
    `;
  }
  await sql`
    UPDATE crm.pending_updates
    SET status = ${pendingResolution},
        override_status = ${pendingResolution === "overridden" ? newStatus : null},
        resolved_at = now(),
        resolved_by = 'owner',
        applied_at = now()
    WHERE id = ${pending.id} AND status = 'pending'
  `;
  await logResolution(pending, auditAction, newStatus);

  const headline = pendingResolution === "approved" ? "Approved" : "Overridden";
  return htmlPage(
    headline,
    `Status updated: <strong>${currentStatus} → ${newStatus}</strong>.`,
    200,
  );
}

async function logResolution(
  pending: PendingRow,
  action: string,
  appliedStatus: string | null,
): Promise<void> {
  // Look up the original sheet edit log row to grab provider/submission context
  const [orig] = await sql<
    Array<{ provider_id: string; submission_id: number | null; column_name: string }>
  >`
    SELECT provider_id, submission_id, column_name
    FROM crm.sheet_edits_log
    WHERE pending_update_id = ${pending.id}
    ORDER BY id ASC
    LIMIT 1
  `;
  if (!orig) return;

  await sql`
    INSERT INTO crm.sheet_edits_log (
      enrolment_id, submission_id, provider_id, column_name,
      old_value, new_value, editor_email, edited_at,
      action, applied_status, pending_update_id, reason
    )
    VALUES (
      ${pending.enrolment_id}, ${orig.submission_id}, ${orig.provider_id}, ${orig.column_name},
      ${pending.current_status}, ${appliedStatus}, ${"owner@switchable.careers"}, now(),
      ${action}, ${appliedStatus}, ${pending.id},
      ${`Resolved by owner via email link`}
    )
  `;
}

// ---- HTML pages ----

function renderOverridePicker(pending: PendingRow, token: string): Response {
  const baseUrl = "/functions/v1/pending-update-confirm";
  const buttons = VALID_STATUSES
    .filter((s) => s !== pending.current_status)
    .map((s) => `
      <a href="${baseUrl}?token=${token}&status=${s}"
         style="display: inline-block; background: #2e7d32; color: #fff; padding: 12px 22px; border-radius: 4px; text-decoration: none; margin: 4px;">
        Set to ${s}
      </a>
    `)
    .join("");

  const body = `
    <p>Choose the correct status for this lead.</p>
    <p>Current: <strong>${pending.current_status}</strong>. AI suggested: <strong>${pending.suggested_status}</strong>.</p>
    ${pending.ai_summary ? `<p><em>${escapeHtml(pending.ai_summary)}</em></p>` : ""}
    <div style="margin-top: 24px;">${buttons}</div>
  `;
  return htmlPage("Choose a status", body, 200);
}

function htmlPage(title: string, bodyHtml: string, status: number): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 540px; margin: 60px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.5; }
    h1 { font-size: 22px; margin-bottom: 16px; }
    p { margin-bottom: 12px; }
    a { color: #2e7d32; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${bodyHtml}
  <p style="margin-top: 32px; color: #888; font-size: 13px;">SwitchLeads admin · pending-update-confirm</p>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
