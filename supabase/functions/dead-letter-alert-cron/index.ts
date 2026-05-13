// Edge Function: dead-letter-alert-cron
//
// Hourly check on `leads.dead_letter`. If any unreplayed rows landed in
// the last ~65 minutes, send Charlotte ONE email summarising them. This
// is the "honest signal" alert that closes the gap exposed by Emma
// Newton (submission 416, 2026-05-13): the system DOES log failures
// to dead_letter, but until now nobody read the table until Sasha's
// Monday cycle.
//
// Idempotency: rough time-window dedup only. Cron runs every hour;
// query window is 65 min, so the worst case is a row landing in the
// final 5 min of the previous cycle gets alerted twice. Acceptable
// tradeoff vs adding an alerted_at column + migration. Replaying a
// row (setting replayed_at) immediately removes it from future alerts.
//
// Recipient: getOwnerEmail() from _shared/owner-email.ts.
//
// Auth: x-audit-key / AUDIT_SHARED_SECRET. Deploy with --no-verify-jwt.

import postgres from "npm:postgres@3";
import { sendBrevoEmail } from "../_shared/brevo.ts";
import { getAdminDashboardUrl, getOwnerEmail } from "../_shared/owner-email.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL is not set.");
}

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

interface DeadLetterRow {
  id: number;
  received_at: string;
  source: string;
  error_context: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }

  const providedKey = req.headers.get("x-audit-key");
  if (!providedKey) return new Response("Unauthorized", { status: 401 });

  let expectedKey: string;
  try {
    const [row] = await sql<Array<{ secret: string }>>`
      SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
    `;
    expectedKey = row?.secret ?? "";
    if (!expectedKey) throw new Error("AUDIT_SHARED_SECRET not in vault");
  } catch (err) {
    console.error("vault secret fetch failed:", String(err));
    return json({ error: "AUDIT_SHARED_SECRET not retrievable from vault" }, 500);
  }
  if (providedKey !== expectedKey) {
    return new Response("Unauthorized", { status: 401 });
  }

  const ownerEmail = getOwnerEmail();
  if (!ownerEmail) {
    return json({ ok: true, candidates: 0, sent: 0, skipped: 1, reason: "OWNER_NOTIFICATION_EMAIL / BREVO_SENDER_EMAIL not set" });
  }

  // 65-minute window vs 60-minute cron: acceptable overlap as documented above.
  //
  // Exclude `sheet_drift_detected` rows: those have their own dedicated daily
  // summary email (sheet-drift-reconcile-daily cron at 06:00 UTC) + a
  // per-provider republish workflow on /admin/errors. Surfacing them hourly
  // duplicates the daily channel and would flood the inbox every hour of
  // the 24 hours between 06:00 reconciler runs. Add new excluded sources
  // here as more dedicated channels land.
  const EXCLUDED_SOURCES = ["sheet_drift_detected"];

  const rows = await sql<DeadLetterRow[]>`
    SELECT id, received_at, source, error_context
      FROM leads.dead_letter
     WHERE replayed_at IS NULL
       AND received_at > now() - interval '65 minutes'
       AND source != ALL(${EXCLUDED_SOURCES}::text[])
     ORDER BY received_at DESC
  `;

  if (rows.length === 0) {
    return json({ ok: true, candidates: 0, sent: 0 });
  }

  const totalUnresolved = await sql<Array<{ count: number }>>`
    SELECT count(*)::int AS count
      FROM leads.dead_letter
     WHERE replayed_at IS NULL
       AND source != ALL(${EXCLUDED_SOURCES}::text[])
  `;

  const dashboardUrl = `${getAdminDashboardUrl()}/errors`;
  const subject = `[Platform alert] ${rows.length} new dead_letter row${rows.length === 1 ? "" : "s"} (last hour)`;

  const tableRowsHtml = rows
    .map((r) => {
      const when = new Date(r.received_at).toLocaleString("en-GB", {
        timeZone: "Europe/London",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      const ctx = escapeHtml(r.error_context).slice(0, 400);
      return `<tr>
        <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-family:monospace;font-size:12px;">${r.id}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-size:12px;">${when}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-family:monospace;font-size:11px;">${escapeHtml(r.source)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${ctx}</td>
      </tr>`;
    })
    .join("");

  const html = `
    <p>Hi Charlotte,</p>
    <p><strong>${rows.length}</strong> new <code>leads.dead_letter</code> row${rows.length === 1 ? " landed" : "s landed"} in the last hour. Total unresolved across all time: <strong>${totalUnresolved[0]?.count ?? 0}</strong>.</p>
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:780px;">
      <thead>
        <tr style="background:#f1f5f9;text-align:left;">
          <th style="padding:6px 8px;border-bottom:1px solid #cbd5e1;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">ID</th>
          <th style="padding:6px 8px;border-bottom:1px solid #cbd5e1;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">When (UK)</th>
          <th style="padding:6px 8px;border-bottom:1px solid #cbd5e1;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Source</th>
          <th style="padding:6px 8px;border-bottom:1px solid #cbd5e1;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Error</th>
        </tr>
      </thead>
      <tbody>${tableRowsHtml}</tbody>
    </table>
    <p style="margin-top:18px;">Review and replay on <a href="${dashboardUrl}">${dashboardUrl}</a>.</p>
    <p style="font-size:12px;color:#64748b;">This alert runs hourly. Replay (set <code>replayed_at</code>) on a row to stop it appearing on future alerts. False-positive runs (window = 65 min vs cron = 60 min) are possible for a row landing in the last 5 min of the previous cycle.</p>
  `.trim();

  try {
    await sendBrevoEmail({
      to: [{ email: ownerEmail }],
      subject,
      htmlContent: html,
      tags: ["platform-alert", "dead-letter"],
    });
  } catch (err) {
    console.error("dead-letter-alert send failed:", String(err));
    return json({ ok: false, error: String(err), candidates: rows.length, sent: 0 }, 500);
  }

  return json({ ok: true, candidates: rows.length, sent: 1, total_unresolved: totalUnresolved[0]?.count ?? 0 });
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
