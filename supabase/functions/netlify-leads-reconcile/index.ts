// Edge Function: netlify-leads-reconcile
//
// Hourly reconciliation between Netlify's submission store and leads.submissions.
// Pulls the last 24 hours of submissions from Netlify's REST API, compares each
// one against our DB by Netlify submission id, and back-fills anything missing
// using the shared ingest pipeline. Emails the owner if any row was back-filled
// so a broken webhook becomes observable within 60 minutes instead of days.
//
// Why this exists:
//   The netlify-lead-router Edge Function is the fast path — Netlify POSTs each
//   submission at us and we INSERT it. But the webhook is a single point of
//   failure: Netlify auto-disables it after 6 consecutive non-2xx responses, and
//   we've hit that twice (2026-04-19 Katy, 2026-04-21 Session 3.3). When it's
//   disabled, leads keep landing in Netlify's store but never reach us until a
//   human notices. This function independently reads Netlify's store and closes
//   that gap so no lead is ever lost to a webhook outage.
//
// Scope:
//   - Read last 24h of Netlify submissions (per_page=100). Pilot volume is
//     ~10/day, so one page suffices; we'll paginate if that changes.
//   - Insert-with-idempotency via the shared insertSubmission (migration 0010's
//     partial unique index on raw_payload->>'id'). A reconcile run overlapping
//     with webhook recovery cannot produce duplicates.
//   - On any back-fill, send the owner an alert email so she knows the fast
//     path degraded and can investigate.
//   - Write a leads.dead_letter row per back-fill with source='reconcile_backfill'
//     so Sasha's Monday scan surfaces the pattern.
//
// Auth: same AUDIT_SHARED_SECRET / x-audit-key header pattern as the existing
// netlify-forms-audit function. Reused because this function runs on the same
// cron pattern and has the same security posture (read Netlify + write DB).
//
// Triggered by:
//   - pg_cron job netlify-leads-reconcile-hourly (platform/supabase/data-ops/)
//   - Manual POST for ad-hoc re-runs
//
// Role: writes via functions_writer (inherited from the shared insertSubmission
// transaction). Does not touch crm or any other schema.

import postgres from "npm:postgres@3";
import { insertSubmission, type JsonValue, normaliseAndOverride } from "../_shared/ingest.ts";
import { sendBrevoEmail } from "../_shared/brevo.ts";
import { extractRefCode, processReferral } from "../_shared/referral.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
const NETLIFY_API_TOKEN = Deno.env.get("NETLIFY_API_TOKEN");
const NETLIFY_SITE_ID = Deno.env.get("NETLIFY_SITE_ID");

if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL not set (should be auto-injected by Supabase)");
}

const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 20, prepare: false });

// AUDIT_SHARED_SECRET lives in Supabase Vault as the single source of truth
// (migration 0019). Read via the public.get_shared_secret helper on each
// invocation so secret rotations propagate without redeploys. Cron-triggered
// only — one extra ~10ms SQL round-trip per call is negligible.
async function getAuditSharedSecret(): Promise<string> {
  const rows = await sql<Array<{ secret: string }>>`
    SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
  `;
  return rows[0].secret;
}

// Netlify keeps submissions forever on paid plans and "recent" on free. We only
// need a short look-back: the hourly cron catches drift within 60 min, so a
// 24h window is 24x safety margin against cron outages.
const LOOKBACK_HOURS = 24;
const MAX_PAGES = 5; // defensive cap; pilot volume is ~10/day so 1 page is normal

interface NetlifyApiSubmission {
  id: string;
  form_name?: string;
  form_id?: string;
  site_url?: string;
  created_at?: string;
  data?: Record<string, JsonValue>;
  email?: string;
  first_name?: string;
  last_name?: string;
  [k: string]: unknown;
}

interface BackfillRecord {
  submission_id: number;
  netlify_id: string;
  form_name: string;
  course_id: string | null;
  email: string | null;
  created_at: string | null;
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
  if (!NETLIFY_API_TOKEN || !NETLIFY_SITE_ID) {
    return json({ error: "NETLIFY_API_TOKEN and NETLIFY_SITE_ID must be set" }, 500);
  }

  const startedAt = new Date();
  const cutoff = new Date(startedAt.getTime() - LOOKBACK_HOURS * 3600_000);

  let netlifySubs: NetlifyApiSubmission[];
  try {
    netlifySubs = await fetchNetlifySubmissions(NETLIFY_SITE_ID, NETLIFY_API_TOKEN, cutoff);
  } catch (err) {
    console.error("netlify API fetch failed:", describeError(err));
    return json({ error: `netlify API fetch failed: ${describeError(err)}` }, 502);
  }

  const { netlifyIds: existingNetlifyIds, sessionIds: existingSessionIds } = await fetchExistingIdentities();

  const backfills: BackfillRecord[] = [];
  const errors: Array<{ netlify_id: string; error: string }> = [];
  let alreadyPresent = 0;

  for (const sub of netlifySubs) {
    if (!sub.id) continue;
    if (existingNetlifyIds.has(sub.id)) {
      alreadyPresent++;
      continue;
    }

    // Fallback dedup by session_id. Handles the case where a row was manually
    // back-filled (e.g. via SQL) with a synthetic raw_payload.id — the
    // submission's session_id (from our client-side tracker) is the stable
    // cross-source identifier. Without this, a manual back-fill would be
    // silently duplicated by reconcile on the next run.
    const submissionSessionId = extractSessionId(sub);
    if (submissionSessionId && existingSessionIds.has(submissionSessionId)) {
      alreadyPresent++;
      continue;
    }

    const formName = typeof sub.form_name === "string" ? sub.form_name : null;
    if (!formName) {
      errors.push({ netlify_id: sub.id, error: "missing form_name in Netlify API response" });
      continue;
    }

    // `contact` form is intentionally not persisted by the router; mirror that
    // here so reconcile doesn't back-fill contact enquiries into leads.submissions.
    if (formName === "contact") continue;

    try {
      const row = normaliseAndOverride(formName, sub as Record<string, JsonValue>, sub as JsonValue);
      const result = await insertSubmission(sql, row);

      if (result.duplicate) {
        alreadyPresent++;
        continue;
      }

      backfills.push({
        submission_id: result.id,
        netlify_id: sub.id,
        form_name: formName,
        course_id: row.course_id,
        email: row.email,
        created_at: sub.created_at ?? null,
      });

      await writeBackfillDeadLetter(result.id, sub.id, formName);

      // Mirror the router's referral processing so back-filled leads get the
      // same anti-fraud + leads.referrals row as fast-path leads. Inline-await
      // is fine here: this function runs on an hourly cron, not a user-facing
      // request, so latency from the lookup + transaction doesn't matter.
      // Errors are logged and swallowed so a referral failure can't abort the
      // remainder of the back-fill batch.
      const refCode = extractRefCode(sub as Record<string, JsonValue>);
      if (refCode) {
        try {
          await processReferral(sql, result.id, refCode, row);
        } catch (err) {
          console.error(
            `referral processing failed for back-filled lead ${result.id}:`,
            describeError(err),
          );
        }
      }
    } catch (err) {
      console.error(`reconcile insert failed for ${sub.id}:`, describeError(err));
      errors.push({ netlify_id: sub.id, error: describeError(err) });
    }
  }

  // Alert the owner whenever reconcile had to act. Fire-and-forget via
  // waitUntil so the HTTP response doesn't block on Brevo.
  if (backfills.length > 0) {
    const alertTask = sendReconcileAlert(backfills, errors).catch((alertErr) => {
      console.error("reconcile alert email failed:", describeError(alertErr));
    });
    const runtime = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (runtime?.waitUntil) {
      runtime.waitUntil(alertTask);
    }
  }

  return json({
    status: "ok",
    window_hours: LOOKBACK_HOURS,
    netlify_seen: netlifySubs.length,
    already_present: alreadyPresent,
    backfilled: backfills.length,
    errors: errors.length,
    backfills,
    errors_detail: errors,
    ran_at: startedAt.toISOString(),
  });
});

// ---- Netlify API ----

async function fetchNetlifySubmissions(
  siteId: string,
  apiToken: string,
  cutoff: Date,
): Promise<NetlifyApiSubmission[]> {
  const collected: NetlifyApiSubmission[] = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const url = `https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/submissions?per_page=100&page=${page}`;
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${apiToken}`,
        accept: "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<body unreadable>");
      throw new Error(`Netlify API ${res.status}: ${text.slice(0, 300)}`);
    }
    const parsed = (await res.json()) as NetlifyApiSubmission[];
    if (!Array.isArray(parsed)) {
      throw new Error("Netlify API returned non-array");
    }
    if (parsed.length === 0) break;

    let sawOlderThanCutoff = false;
    for (const s of parsed) {
      const created = s.created_at ? new Date(s.created_at) : null;
      if (created && created < cutoff) {
        sawOlderThanCutoff = true;
        continue; // skip older rows; we still check the rest of the page in case order isn't strict
      }
      collected.push(s);
    }

    // Netlify returns newest first. Once we see anything older than the cutoff,
    // subsequent pages are older too — stop paginating.
    if (sawOlderThanCutoff) break;
    if (parsed.length < 100) break; // end of data

    page++;
  }

  return collected;
}

async function fetchExistingIdentities(): Promise<{ netlifyIds: Set<string>; sessionIds: Set<string> }> {
  const rows = await sql<Array<{ netlify_id: string | null; session_id: string | null }>>`
    SELECT raw_payload->>'id' AS netlify_id,
           session_id::text  AS session_id
      FROM leads.submissions
     WHERE created_at > now() - interval '${sql.unsafe(String(LOOKBACK_HOURS + 24))} hours'
       AND (raw_payload->>'id' IS NOT NULL OR session_id IS NOT NULL)
  `;
  const netlifyIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const r of rows) {
    if (r.netlify_id) netlifyIds.add(r.netlify_id);
    if (r.session_id) sessionIds.add(r.session_id);
  }
  return { netlifyIds, sessionIds };
}

function extractSessionId(sub: NetlifyApiSubmission): string | null {
  // Netlify's API submission shape puts form fields under `.data`. Our client
  // tracker emits session_id as a hidden input, so it lands here.
  const data = sub.data;
  if (!data || typeof data !== "object") return null;
  const val = (data as Record<string, JsonValue>)["session_id"];
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  // UUID sanity — anything else we ignore rather than risk false-positive dedup.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

// ---- dead letter + alert ----

async function writeBackfillDeadLetter(
  submissionId: number,
  netlifyId: string,
  formName: string,
): Promise<void> {
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        INSERT INTO leads.dead_letter (source, raw_payload, error_context)
        VALUES (
          'reconcile_backfill',
          ${sql.json({ submission_id: submissionId, netlify_id: netlifyId, form_name: formName })},
          ${`Reconcile back-fill — fast path (webhook) did not deliver this submission; back-filled from Netlify API`}
        )
      `;
    });
  } catch (err) {
    console.error("dead_letter write for reconcile back-fill failed:", describeError(err));
  }
}

async function sendReconcileAlert(
  backfills: BackfillRecord[],
  errors: Array<{ netlify_id: string; error: string }>,
): Promise<void> {
  const ownerEmail = Deno.env.get("OWNER_NOTIFICATION_EMAIL") ?? Deno.env.get("BREVO_SENDER_EMAIL");
  if (!ownerEmail) {
    console.error("No owner email configured; cannot send reconcile alert");
    return;
  }

  const rows = backfills
    .map((b) => {
      const leadId = formatLeadId(b.submission_id, b.created_at ?? new Date().toISOString());
      return `<tr><td style="padding:4px 12px 4px 0;"><code>${escapeHtml(leadId)}</code></td><td style="padding:4px 12px 4px 0;">${escapeHtml(b.form_name)}</td><td style="padding:4px 12px 4px 0;">${escapeHtml(b.course_id ?? "-")}</td><td style="padding:4px 0;">${escapeHtml(b.email ?? "-")}</td></tr>`;
    })
    .join("");

  const errorsHtml = errors.length > 0
    ? `<h3 style="font-size:15px;margin:24px 0 8px;color:#a00;">Errors during back-fill</h3><ul>${errors.map((e) => `<li><code>${escapeHtml(e.netlify_id)}</code>: ${escapeHtml(e.error)}</li>`).join("")}</ul>`
    : "";

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#111;line-height:1.5;">
<h2 style="margin:0 0 8px;font-size:20px;">Reconcile back-filled ${backfills.length} lead${backfills.length === 1 ? "" : "s"}</h2>
<p style="color:#555;margin:0 0 16px;">The webhook didn't deliver ${backfills.length === 1 ? "this submission" : "these submissions"} — reconcile picked ${backfills.length === 1 ? "it" : "them"} up from Netlify and inserted into <code>leads.submissions</code>. The fast path likely needs attention.</p>

<table style="border-collapse:collapse;font-size:14px;margin:0 0 16px;">
  <thead><tr style="border-bottom:1px solid #eee;"><th style="text-align:left;padding:4px 12px 4px 0;">Lead ID</th><th style="text-align:left;padding:4px 12px 4px 0;">Form</th><th style="text-align:left;padding:4px 12px 4px 0;">Course</th><th style="text-align:left;padding:4px 0;">Email</th></tr></thead>
  <tbody>${rows}</tbody>
</table>

<p style="margin:0 0 8px;color:#555;">Next steps:</p>
<ul style="margin:0 0 24px;color:#555;">
  <li>Check Netlify → Forms → outgoing webhooks — if disabled, recreate it.</li>
  <li>Check Supabase Edge Function logs for <code>netlify-lead-router</code> errors.</li>
  <li>Each back-fill is logged in <code>leads.dead_letter</code> with <code>source='reconcile_backfill'</code>.</li>
</ul>

${errorsHtml}

<p style="color:#888;font-size:13px;margin-top:32px;">Sent by <code>netlify-leads-reconcile</code>.</p>
</body></html>`;

  const res = await sendBrevoEmail({
    to: [{ email: ownerEmail, name: "Charlotte" }],
    subject: `Leads reconcile: back-filled ${backfills.length} lead${backfills.length === 1 ? "" : "s"}`,
    htmlContent: html,
    tags: ["reconcile-alert", "leads-reconcile"],
  });
  if (!res.ok) {
    console.error(`reconcile alert email failed: ${res.error}`);
  }
}

// ---- helpers (small duplicates, intentionally kept here rather than adding to _shared) ----

function formatLeadId(id: number, submittedAt: string): string {
  const d = new Date(submittedAt);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const nnnn = String(id).padStart(4, "0");
  return `SL-${yy}-${mm}-${nnnn}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function describeError(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
