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

  // Severity split — mirrors app/app/admin/errors/page.tsx SOURCE_EXPLANATIONS.
  // "Needs you" = a real failure needing a code/config/owner action. Everything
  // else is routine drift or self-healing retries. An unknown source defaults
  // to needs-you so a genuinely new failure type still alerts.
  const ACTION_SOURCES = new Set([
    "edge_function_sheet_append",
    "netlify_forms",
    "netlify_audit",
    "edge_function_provider_email",
    "edge_function_meta_ingest_upsert",
    "edge_function_labs_event",
    "fastrack_form",
  ]);
  const KNOWN_ROUTINE_SOURCES = new Set([
    "sheet_drift_detected",
    "brevo_attribute_drift",
    "brevo_attribute_reconcile_async_check_result",
    "reconcile_backfill",
    "edge_function_partial_capture",
    "edge_function_brevo_upsert",
    "edge_function_brevo_upsert_no_match",
    "edge_function_brevo_chase",
    "edge_function_crm_push",
    "edge_function_meta_ingest_api",
    "edge_function_meta_ingest_fetch",
    "edge_function_meta_ingest_parse",
    "brevo_transactional_sms",
  ]);
  const isAction = (source: string): boolean =>
    ACTION_SOURCES.has(source) ? true : KNOWN_ROUTINE_SOURCES.has(source) ? false : true;

  const ACTION_LABEL: Record<string, string> = {
    edge_function_sheet_append: "Lead didn't reach a provider's sheet",
    netlify_forms: "A form submission couldn't be saved",
    netlify_audit: "Form webhook config drift (possible silent lead loss)",
    edge_function_provider_email: "Provider notification email failed",
    edge_function_meta_ingest_upsert: "Meta ads data couldn't be written",
    edge_function_labs_event: "Labs analytics event couldn't be saved",
    fastrack_form: "Fastrack form couldn't link to a lead",
  };
  const ROUTINE_LABEL: Record<string, string> = {
    sheet_drift_detected: "Provider sheet a step behind the database",
    brevo_attribute_drift: "Brevo contacts a step behind (daily check)",
    brevo_attribute_reconcile_async_check_result: "Brevo check run logs",
    reconcile_backfill: "Leads the backup sweep recovered (auto-routed)",
    edge_function_partial_capture: "Abandoned half-filled forms",
    edge_function_brevo_upsert: "Brevo sync retries (self-healing)",
    edge_function_brevo_upsert_no_match: "Brevo sync, no course match",
    edge_function_brevo_chase: "Provider chaser retries",
    edge_function_crm_push: "Provider CRM push retries",
    edge_function_meta_ingest_api: "Meta ads ingest retries",
    edge_function_meta_ingest_fetch: "Meta ads ingest retries",
    edge_function_meta_ingest_parse: "Meta ads ingest retries",
    brevo_transactional_sms: "SMS not sent (top up Brevo credits)",
  };

  const dashboardUrl = `${getAdminDashboardUrl()}/errors`;
  const totalNew = rows.length;

  const orderedBuckets = Array.from(buckets.values()).sort((a, b) => b.count - a.count);
  const actionBuckets = orderedBuckets.filter((b) => isAction(b.source));
  const routineBuckets = orderedBuckets.filter((b) => !isAction(b.source));
  const actionCount = actionBuckets.reduce((n, b) => n + b.count, 0);
  const routineCount = routineBuckets.reduce((n, b) => n + b.count, 0);

  const subject = actionCount > 0
    ? `[Platform] ${actionCount} need${actionCount === 1 ? "s" : ""} you, ${routineCount} routine (last 24h)`
    : `[Platform] All clear, ${routineCount} routine notice${routineCount === 1 ? "" : "s"} (last 24h)`;

  const actionHtml = actionBuckets
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
        <div style="margin-bottom:14px;padding:10px 14px;border:1px solid #fca5a5;border-radius:6px;background:#fef2f2;">
          <p style="margin:0 0 6px 0;"><strong style="font-size:13px;color:#991b1b;">${escapeHtml(ACTION_LABEL[b.source] ?? b.source)}</strong>
          <span style="background:#fee2e2;color:#991b1b;padding:1px 8px;border-radius:10px;font-size:11px;margin-left:6px;">${b.count}</span>
          <br><span style="font-family:monospace;font-size:10px;color:#94a3b8;">${escapeHtml(b.source)}</span></p>
          <ul style="margin:0;padding:0 0 0 16px;">${samplesHtml}</ul>
        </div>`;
    })
    .join("");

  const routineHtml = routineBuckets
    .map((b) =>
      `<li style="font-size:12px;color:#475569;margin-bottom:3px;">
        <strong style="color:#334155;">${escapeHtml(ROUTINE_LABEL[b.source] ?? b.source)}</strong>
        <span style="color:#94a3b8;"> · ${b.count}</span>
      </li>`,
    )
    .join("");

  const leadLine = actionCount > 0
    ? `<strong>${actionCount}</strong> thing${actionCount === 1 ? "" : "s"} need${actionCount === 1 ? "s" : ""} a look. <strong>${routineCount}</strong> ${routineCount === 1 ? "is" : "are"} routine drift, nothing to do.`
    : `Nothing needs you. All <strong>${routineCount}</strong> ${routineCount === 1 ? "row is" : "rows are"} routine drift (sheet and Brevo sync lag, self-healing retries). Clear them on the dashboard whenever.`;

  const html = `
    <p>Hi Charlotte,</p>
    <p>Last 24h on the platform: ${leadLine}</p>
    ${actionCount > 0 ? `<h3 style="font-size:14px;color:#991b1b;margin:18px 0 8px;">Needs you (${actionCount})</h3>${actionHtml}` : ""}
    ${routineCount > 0 ? `<h3 style="font-size:14px;color:#334155;margin:18px 0 8px;">Routine, no action (${routineCount})</h3>
      <p style="font-size:12px;color:#64748b;margin:0 0 6px;">Sync lag and self-healing retries. Every lead is safe in the database. Bulk-clear any time.</p>
      <ul style="margin:0;padding:0 0 0 16px;">${routineHtml}</ul>` : ""}
    <p style="margin-top:18px;font-size:13px;">Open the live list to triage: <a href="${dashboardUrl}">${dashboardUrl}</a>. Total unresolved all-time: <strong>${totalUnresolved}</strong>.</p>
    <p style="font-size:11px;color:#64748b;margin-top:18px;">Daily 06:30 UTC. "Needs you" are real failures; "routine" are drift notices and self-healing retries that clear themselves or take one click. Quiet days send nothing.</p>
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
