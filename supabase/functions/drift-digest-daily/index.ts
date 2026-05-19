// Edge Function: drift-digest-daily
//
// Daily 06:30 UTC digest. Replaces the hourly dead-letter-alert-cron +
// the daily sheet-drift email; at current volumes a 24h delay on
// transient failures is acceptable and the noise reduction is worth more
// than the granularity.
//
// Source of truth: leads.dead_letter. Every reconciler and webhook handler
// in the platform already writes a row here on failure; the digest groups
// new (replayed_at IS NULL, received in the last 24h) rows by source and
// puts one email together.
//
// Quiet days send nothing. The dead-letter table + the /admin/errors UI
// remain the always-on surface — the digest is the inbox channel.
//
// Auth: x-audit-key / AUDIT_SHARED_SECRET. Deploy with --no-verify-jwt.

import postgres from "npm:postgres@3";
import { sendBrevoEmail } from "../_shared/brevo.ts";
import { getAdminDashboardUrl, getOwnerEmail } from "../_shared/owner-email.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) throw new Error("SUPABASE_DB_URL not set");

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
  error_context: string | null;
}

interface SourceBucket {
  source: string;
  count: number;
  samples: DeadLetterRow[];
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
    return json({ ok: true, candidates: 0, sent: 0, skipped: 1, reason: "owner email env var not set" });
  }

  // 24h window. Cron schedules the function at 06:30 UTC every day; this
  // 1500-minute window matches with a 30-min overlap to avoid losing rows
  // landing right around the cron boundary. Replayed rows drop out the
  // moment replayed_at is stamped, so any row already handled stays out
  // of tomorrow's digest.
  const rows = await sql<DeadLetterRow[]>`
    SELECT id, received_at, source, error_context
      FROM leads.dead_letter
     WHERE replayed_at IS NULL
       AND received_at > now() - interval '25 hours'
     ORDER BY received_at DESC
  `;

  if (rows.length === 0) {
    return json({ ok: true, candidates: 0, sent: 0, reason: "quiet day, no email sent" });
  }

  // Group by source so the digest reads as "here's what happened in each
  // bucket" rather than 200 line-items. Keep up to 3 most-recent samples
  // per source for context.
  const buckets = new Map<string, SourceBucket>();
  for (const r of rows) {
    let b = buckets.get(r.source);
    if (!b) {
      b = { source: r.source, count: 0, samples: [] };
      buckets.set(r.source, b);
    }
    b.count++;
    if (b.samples.length < 3) b.samples.push(r);
  }

  // Total still-unresolved (all-time) so Charlotte can see whether the
  // dead_letter table is growing or holding steady.
  const [{ count: totalUnresolved }] = await sql<Array<{ count: number }>>`
    SELECT count(*)::int AS count
      FROM leads.dead_letter
     WHERE replayed_at IS NULL
  `;

  const dashboardUrl = `${getAdminDashboardUrl()}/errors`;
  const totalNew = rows.length;
  const subject = `[Platform digest] ${totalNew} drift row${totalNew === 1 ? "" : "s"} in the last 24h`;

  const orderedBuckets = Array.from(buckets.values()).sort((a, b) => b.count - a.count);
  const bucketsHtml = orderedBuckets
    .map((b) => {
      const samplesHtml = b.samples
        .map((s) => {
          const when = new Date(s.received_at).toLocaleString("en-GB", {
            timeZone: "Europe/London",
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          });
          const ctx = escapeHtml((s.error_context ?? "").split("\n")[0] ?? "").slice(0, 280);
          return `<li style="font-size:12px;color:#475569;margin-bottom:4px;">
            <code style="font-size:11px;color:#0f172a;">#${s.id}</code>
            <span style="color:#94a3b8;"> · ${when}</span>
            <br><span style="color:#334155;">${ctx || "(no error message)"}</span>
          </li>`;
        })
        .join("");
      return `
        <div style="margin-bottom:18px;padding:10px 14px;border:1px solid #e2e8f0;border-radius:6px;">
          <p style="margin:0 0 6px 0;"><strong style="font-family:monospace;font-size:13px;">${escapeHtml(b.source)}</strong>
          <span style="background:#fef3c7;color:#92400e;padding:1px 8px;border-radius:10px;font-size:11px;margin-left:6px;">${b.count}</span></p>
          <ul style="margin:0;padding:0 0 0 16px;">${samplesHtml}</ul>
        </div>`;
    })
    .join("");

  const html = `
    <p>Hi Charlotte,</p>
    <p>Last 24h on the platform: <strong>${totalNew}</strong> new dead_letter row${totalNew === 1 ? "" : "s"} across <strong>${orderedBuckets.length}</strong> source${orderedBuckets.length === 1 ? "" : "s"}. Total unresolved all-time: <strong>${totalUnresolved}</strong>.</p>
    ${bucketsHtml}
    <p style="margin-top:18px;font-size:13px;">Open the live list to triage: <a href="${dashboardUrl}">${dashboardUrl}</a>.</p>
    <p style="font-size:11px;color:#64748b;margin-top:18px;">Daily 06:30 UTC. Replaces the hourly dead-letter alert + per-cron sheet-drift email — same signals, one inbox channel. Replay or flag rows on the dashboard to stop them appearing in tomorrow&apos;s digest. Quiet days send nothing.</p>
  `.trim();

  try {
    await sendBrevoEmail({
      to: [{ email: ownerEmail }],
      subject,
      htmlContent: html,
      tags: ["platform-digest", "drift-digest-daily"],
    });
  } catch (err) {
    console.error("drift-digest send failed:", String(err));
    return json({ ok: false, error: String(err), candidates: totalNew, sent: 0 }, 500);
  }

  return json({
    ok: true,
    candidates: totalNew,
    sent: 1,
    sources: orderedBuckets.length,
    total_unresolved: totalUnresolved,
  });
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
