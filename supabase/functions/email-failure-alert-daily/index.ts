// Edge Function: email-failure-alert-daily
//
// Phase 6c of the email platform rearchitecture (last item per spec at
// platform/docs/email-platform-rearchitecture-spec.md). Daily 04:30 UTC.
//
// Scans crm.email_log for utility transactional sends in the FAILED state
// over the last 24 hours. If the count exceeds the threshold (default 3),
// emails the owner and writes a leads.dead_letter row so Mira's Monday
// audit picks it up too.
//
// Why this matters: every utility send already runs through sendTransactional
// which retries 250ms / 1s / 4s on transient errors before marking the row
// failed. So a failed row in email_log means three rapid retries inside the
// same submission already exhausted. Three of those clustered in a day
// signals a systemic issue (Brevo API outage, expired key, template
// deletion, rate-limit hammering) that Charlotte should know about
// immediately, not at next dashboard glance.
//
// Auth: x-audit-key / AUDIT_SHARED_SECRET (same pattern as the other crons).
// Deploy with --no-verify-jwt — auth is the audit-key header.

import postgres from "npm:postgres@3";
import { sendBrevoEmail } from "../_shared/brevo.ts";
import { getOwnerEmail } from "../_shared/owner-email.ts";

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

const FAILURE_THRESHOLD = 3;

interface FailureRow {
  id: number;
  submission_id: number | null;
  email_type: string;
  recipient_email: string;
  triggered_at: string;
  error_text: string | null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }

  // Auth
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

  // Pull failed sends in the last 24h
  let failures: FailureRow[];
  try {
    failures = await sql<FailureRow[]>`
      SELECT id, submission_id, email_type::text, recipient_email,
             triggered_at, error_text
        FROM crm.email_log
       WHERE channel = 'transactional'
         AND status = 'failed'
         AND triggered_at >= now() - interval '24 hours'
       ORDER BY triggered_at DESC
       LIMIT 100
    `;
  } catch (err) {
    console.error("failure scan query failed:", String(err));
    return json({ error: `failure scan: ${String(err)}` }, 500);
  }

  const failureCount = failures.length;

  if (failureCount < FAILURE_THRESHOLD) {
    return json({
      checked_at: new Date().toISOString(),
      failure_count: failureCount,
      threshold: FAILURE_THRESHOLD,
      alert_fired: false,
    }, 200);
  }

  // Alert path. Group by email_type for the summary, list the most recent 10
  // failures inline for context.
  const byType: Record<string, number> = {};
  for (const f of failures) byType[f.email_type] = (byType[f.email_type] ?? 0) + 1;

  const ownerEmail = getOwnerEmail();
  const emailSubject = `Switchable utility email failures: ${failureCount} in last 24h`;

  const summaryRows = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `<li><code>${type}</code>: ${count}</li>`)
    .join("");

  const recentRows = failures.slice(0, 10).map((f) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-family:monospace;font-size:12px">${f.email_type}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:12px">${escapeHtml(f.recipient_email)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:12px">${formatDate(f.triggered_at)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:12px;color:#b91c1c">${escapeHtml(f.error_text ?? "—")}</td>
    </tr>
  `).join("");

  const htmlContent = `
    <p>${failureCount} utility transactional sends failed in the last 24h, exceeding the ${FAILURE_THRESHOLD}-failure threshold. Investigate before the next cron run if possible.</p>
    <p><strong>By email type:</strong></p>
    <ul>${summaryRows}</ul>
    <p><strong>Most recent failures:</strong></p>
    <table style="border-collapse:collapse;width:100%;font-size:12px">
      <thead><tr style="background:#f4f4f5">
        <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #ddd">Type</th>
        <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #ddd">Recipient</th>
        <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #ddd">When</th>
        <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #ddd">Error</th>
      </tr></thead>
      <tbody>${recentRows}</tbody>
    </table>
    <p style="margin-top:16px;color:#71717a;font-size:12px">Source: <code>crm.email_log</code> where <code>status='failed'</code> in the last 24 hours. Detection threshold: ${FAILURE_THRESHOLD} failures. Cron: <code>email-failure-alert-daily</code> 04:30 UTC.</p>
  `;

  let alertSent = false;
  try {
    const result = await sendBrevoEmail({
      to: [{ email: ownerEmail }],
      subject: emailSubject,
      htmlContent,
      brand: "switchleads",
      tags: ["alert", "email-failure", "cron"],
    });
    alertSent = result.ok;
    if (!result.ok) {
      console.error("alert email send failed:", result.error);
    }
  } catch (err) {
    console.error("alert email send threw:", String(err));
  }

  // Write a dead_letter row so the audit + dashboard pick it up too.
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        INSERT INTO leads.dead_letter (source, error_context, raw_payload)
        VALUES (
          'email_failure_alert',
          ${`${failureCount} transactional sends failed in last 24h (threshold ${FAILURE_THRESHOLD})`},
          ${sql.json({
            failure_count: failureCount,
            threshold: FAILURE_THRESHOLD,
            by_type: byType,
            samples: failures.slice(0, 10).map((f) => ({
              email_type: f.email_type,
              recipient_email: f.recipient_email,
              triggered_at: f.triggered_at,
              error_text: f.error_text,
            })),
            alert_email_sent: alertSent,
          })}
        )
      `;
    });
  } catch (err) {
    console.error("dead_letter alert insert failed:", String(err));
  }

  return json({
    checked_at: new Date().toISOString(),
    failure_count: failureCount,
    threshold: FAILURE_THRESHOLD,
    alert_fired: true,
    alert_email_sent: alertSent,
    by_type: byType,
  }, 200);
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
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
