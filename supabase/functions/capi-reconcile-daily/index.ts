// Edge Function: capi-reconcile-daily
//
// The monitor that ends "we found out weeks later". Once a day it compares,
// per brand (B2C + B2B):
//   - expected: primary, ROUTABLE leads (parent_submission_id IS NULL, event_id
//     present, and !is_dq || private-pay) — the population the router actually
//     sends server-side CAPI for. DQ/waitlist leads are excluded so they don't
//     show as false "missing";
//   - sent_ok: those with a successful leads.capi_log row (2xx + events_received≥1);
//   - missing: expected leads with no successful send;
//   - failed: capi_log rows in the window that came back non-2xx / 0 received;
//   - wrongly_sent: successful CAPI Lead sends for leads that should NEVER have
//     been sent (DQ-and-not-private, or a re-application/child). This is the
//     check that would have caught the 15 Jun regression on day one.
// If anything is missing, failed, or wrongly sent, it emails the owner. Healthy
// days are silent.
//
// This makes a silent CAPI outage (expired token, Stape drop, bad deploy) visible
// the next morning instead of by accident. Full plan:
// platform/docs/capi-server-side-scoping-2026-06-15.md
//
// Auth: x-audit-key header validated against the Vault AUDIT_SHARED_SECRET
// (public.get_shared_secret), same posture as netlify-leads-reconcile. Cron-only.
//
// Body: { "dry_run"?: boolean } — dry_run computes + returns the summary but
// sends no email (panel-triggered). Cron posts {} (apply, emails on problem).

import postgres from "npm:postgres@3";
import { sendBrevoEmail } from "../_shared/brevo.ts";
import { getOwnerEmail } from "../_shared/owner-email.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL not set (should be auto-injected by Supabase)");
}

const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 20, prepare: false });

async function getAuditSharedSecret(): Promise<string> {
  const rows = await sql<Array<{ secret: string }>>`
    SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
  `;
  return rows[0].secret;
}

interface BrandSummary {
  brand: string;
  expected: number;
  sent_ok: number;
  missing: number;
  failed: number;
  wrongly_sent: number;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const providedKey = req.headers.get("x-audit-key");
  let expectedKey: string;
  try {
    expectedKey = await getAuditSharedSecret();
  } catch (err) {
    console.error("vault secret fetch failed:", describeError(err));
    return json({ error: "AUDIT_SHARED_SECRET not retrievable from vault" }, 500);
  }
  if (providedKey !== expectedKey) {
    return new Response("Unauthorized", { status: 401 });
  }

  let dryRun = false;
  if (req.method === "POST") {
    try {
      const body = await req.json();
      dryRun = body?.dry_run === true;
    } catch {
      // empty/invalid body → apply mode (cron posts {})
    }
  }

  // 25h look-back (a once-daily run covers the prior day with margin); 30-min
  // grace so in-flight background sends settle before we count them missing.
  let summaries: BrandSummary[];
  try {
    const expectedRows = await sql<Array<{ brand: string; expected: number; sent_ok: number; missing: number }>>`
      WITH win AS (
        SELECT s.id,
          CASE WHEN s.lead_type = 'employer_apprenticeship' THEN 'b2b' ELSE 'b2c' END AS brand
        FROM leads.submissions s
        WHERE s.parent_submission_id IS NULL
          AND s.event_id IS NOT NULL
          -- Routable only: mirrors the router's CAPI guard
          -- (!is_dq || private-pay). DQ/waitlist leads are NOT sent server-side,
          -- so counting them as "expected" would raise a false missing alarm.
          AND (s.is_dq = false OR s.pay_route = 'private')
          AND s.created_at >= now() - interval '25 hours'
          AND s.created_at <  now() - interval '30 minutes'
      ),
      ok AS (
        SELECT DISTINCT submission_id
        FROM leads.capi_log
        WHERE events_received >= 1 AND http_status BETWEEN 200 AND 299
      )
      SELECT w.brand,
        count(*)::int AS expected,
        count(*) FILTER (WHERE o.submission_id IS NOT NULL)::int AS sent_ok,
        count(*) FILTER (WHERE o.submission_id IS NULL)::int  AS missing
      FROM win w
      LEFT JOIN ok o ON o.submission_id = w.id
      GROUP BY w.brand
    `;
    const failedRows = await sql<Array<{ brand: string; failed: number }>>`
      SELECT brand, count(*)::int AS failed
      FROM leads.capi_log
      WHERE sent_at >= now() - interval '25 hours'
        AND NOT (http_status BETWEEN 200 AND 299 AND coalesce(events_received, 0) >= 1)
      GROUP BY brand
    `;
    const failedByBrand = new Map(failedRows.map((r) => [r.brand, r.failed]));
    // wrongly_sent = the alarm that would have caught the 15 Jun regression:
    // a successful CAPI Lead send for a lead that should NEVER have been sent
    // (DQ-and-not-private, or a re-application/child). The router guard now
    // prevents these, so a non-zero count means the guard regressed again.
    const wrongRows = await sql<Array<{ brand: string; wrongly_sent: number }>>`
      SELECT c.brand, count(*)::int AS wrongly_sent
      FROM leads.capi_log c
      JOIN leads.submissions s ON s.id = c.submission_id
      WHERE c.sent_at >= now() - interval '25 hours'
        AND c.event_name = 'Lead'
        AND c.http_status BETWEEN 200 AND 299
        AND coalesce(c.events_received, 0) >= 1
        AND (
          s.parent_submission_id IS NOT NULL
          OR (s.is_dq = true AND s.pay_route IS DISTINCT FROM 'private')
        )
      GROUP BY c.brand
    `;
    const wronglyByBrand = new Map(wrongRows.map((r) => [r.brand, r.wrongly_sent]));
    const brands = new Set<string>([...expectedRows.map((r) => r.brand), ...failedByBrand.keys(), ...wronglyByBrand.keys(), "b2c", "b2b"]);
    summaries = [...brands].map((brand) => {
      const e = expectedRows.find((r) => r.brand === brand);
      return {
        brand,
        expected: e?.expected ?? 0,
        sent_ok: e?.sent_ok ?? 0,
        missing: e?.missing ?? 0,
        failed: failedByBrand.get(brand) ?? 0,
        wrongly_sent: wronglyByBrand.get(brand) ?? 0,
      };
    });
  } catch (err) {
    console.error("capi reconcile query failed:", describeError(err));
    return json({ error: "reconcile query failed", detail: describeError(err) }, 500);
  }

  const problem = summaries.some((s) => s.missing > 0 || s.failed > 0 || s.wrongly_sent > 0);

  if (problem && !dryRun) {
    try {
      const ownerEmail = await getOwnerEmail(sql);
      const rowsHtml = summaries
        .map(
          (s) =>
            `<tr><td>${s.brand.toUpperCase()}</td><td>${s.expected}</td><td>${s.sent_ok}</td>` +
            `<td><strong>${s.missing}</strong></td><td><strong>${s.failed}</strong></td>` +
            `<td><strong>${s.wrongly_sent}</strong></td></tr>`,
        )
        .join("");
      const html = `
        <p>The daily Meta CAPI reconcile found a discrepancy in the last 25 hours.</p>
        <table border="1" cellpadding="6" cellspacing="0">
          <tr><th>Brand</th><th>Expected</th><th>Sent OK</th><th>Missing</th><th>Failed sends</th><th>Wrongly sent</th></tr>
          ${rowsHtml}
        </table>
        <p><strong>Missing</strong> = a routable lead that should have fired CAPI but has no successful send logged.
        <strong>Failed sends</strong> = CAPI attempts Meta rejected (check the token, pixel, or payload).
        <strong>Wrongly sent</strong> = a CAPI Lead sent for a lead that should never have been sent (DQ/waitlist or a re-application). Non-zero means the router's DQ guard has regressed; check netlify-lead-router.</p>
        <p>First checks: is the Meta access token still valid (System User, never-expire)? Did a recent deploy
        change the routers? See platform/docs/capi-server-side-scoping-2026-06-15.md.</p>
      `;
      const res = await sendBrevoEmail({
        to: [{ email: ownerEmail, name: "Charlotte" }],
        subject: `CAPI reconcile: ${summaries.reduce((n, s) => n + s.missing + s.failed + s.wrongly_sent, 0)} unsent/failed/wrongly-sent in 25h`,
        htmlContent: html,
        tags: ["capi-reconcile-alert"],
      });
      if (!res.ok) console.error("CAPI reconcile alert email failed:", res.error);
    } catch (err) {
      console.error("CAPI reconcile alert send failed:", describeError(err));
    }
  }

  return json({ status: "ok", dry_run: dryRun, problem, summaries });
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
