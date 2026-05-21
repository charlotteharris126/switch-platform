// Edge Function: sms-fastrack-prompt-cron
//
// Chunk 3 of SMS utility build per `switchable/email/docs/sms-utility-design.md`
// (Wren, locked 2026-05-21). Trigger A — fastrack-link prompt SMS.
//
// Scans for matched leads that landed between 10 minutes and 1 hour ago and
// haven't fastracked yet, then fires `fireFastrackLinkSms` for each. The
// 10-minute lag is deliberate: fastrack form lives on the thank-you page,
// and the engaged subset will naturally complete it within the first few
// minutes of landing. Sending earlier would push the link to learners who
// are mid-form. The 1-hour stop prevents back-firing on stale leads.
//
// Fires ONCE per submission via the sendSms idempotency check on
// (submission_id, 'call_reminder_fastrack_link'). Re-runs of the cron find
// the existing row and skip.
//
// Schedule: pg_cron every minute (migration 0158). The narrow time window
// (10-60 min) caps the per-run candidate set tightly; we expect ~5-15
// candidates per minute at peak.
//
// Auth: x-audit-key matched against AUDIT_SHARED_SECRET (vault). Cron calls
// from pg_net include the header per migration 0158.

import postgres from "npm:postgres@3";
import { fireFastrackLinkSms } from "../_shared/sms-utility.ts";
import {
  SUBMISSION_FULL_COLUMNS,
  type ProviderRow,
  type SubmissionRow,
} from "../_shared/route-lead.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL not set");
}
const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 20, prepare: false });

async function getAuditSharedSecret(): Promise<string> {
  const rows = await sql<Array<{ secret: string }>>`
    SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
  `;
  const secret = rows[0]?.secret;
  if (!secret) throw new Error("AUDIT_SHARED_SECRET not in vault");
  return secret;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const providedKey = req.headers.get("x-audit-key");
  let expectedKey: string;
  try {
    expectedKey = await getAuditSharedSecret();
  } catch (err) {
    console.error("vault secret fetch failed:", String(err));
    return json({ error: "AUDIT_SHARED_SECRET not retrievable" }, 500);
  }
  if (!providedKey || providedKey !== expectedKey) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Find eligible candidates: matched funded leads, routed 10-60 min ago,
  // not yet fastracked, no prior fastrack-link SMS row, provider opt-in.
  // The sms_log idempotency check inside sendSms is the second-line guard;
  // putting it in the WHERE here keeps the per-minute candidate set tight.
  let submissionIds: number[] = [];
  try {
    const rows = await sql<Array<{ submission_id: number }>>`
      SELECT s.id AS submission_id
        FROM leads.submissions s
        JOIN crm.enrolments  e ON e.submission_id = s.id
        JOIN crm.providers   p ON p.provider_id   = s.primary_routed_to
       WHERE s.archived_at IS NULL
         AND s.is_dq        = false
         AND s.fastracked_at IS NULL
         AND s.phone IS NOT NULL AND s.phone <> ''
         AND s.funding_category IN ('gov','loan')
         AND s.primary_routed_to IS NOT NULL
         AND p.sms_utility_enabled = true
         AND e.status = 'open'
         AND e.sent_to_provider_at < now() - interval '10 minutes'
         AND e.sent_to_provider_at > now() - interval '60 minutes'
         AND NOT EXISTS (
           SELECT 1 FROM crm.sms_log l
            WHERE l.submission_id = s.id
              AND l.comm_type = 'call_reminder_fastrack_link'
         )
       ORDER BY e.sent_to_provider_at ASC
       LIMIT 50
    `;
    submissionIds = rows.map((r) => Number(r.submission_id));
  } catch (err) {
    console.error("sms-fastrack-prompt-cron candidate scan failed:", String(err));
    return json({ ok: false, error: `scan: ${String(err)}` }, 500);
  }

  if (submissionIds.length === 0) {
    return json({ ok: true, scanned: 0, sent: 0, skipped: 0, failed: 0 });
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const skippedReasons: Record<string, number> = {};

  for (const submissionId of submissionIds) {
    try {
      const [submission] = await sql<SubmissionRow[]>`
        SELECT ${sql.unsafe(SUBMISSION_FULL_COLUMNS)}
          FROM leads.submissions
         WHERE id = ${submissionId}
         LIMIT 1
      `;
      if (!submission || !submission.primary_routed_to) {
        skipped++;
        skippedReasons["no_submission_or_provider"] = (skippedReasons["no_submission_or_provider"] ?? 0) + 1;
        continue;
      }
      const [provider] = await sql<ProviderRow[]>`
        SELECT provider_id, company_name, contact_email, contact_name,
               sheet_id, sheet_webhook_url, crm_webhook_url, cc_emails,
               active, archived_at, auto_route_enabled,
               trust_line, regions, portal_enabled, regional_contacts
          FROM crm.providers
         WHERE provider_id = ${submission.primary_routed_to}
         LIMIT 1
      `;
      if (!provider) {
        skipped++;
        skippedReasons["provider_not_found"] = (skippedReasons["provider_not_found"] ?? 0) + 1;
        continue;
      }

      const outcome = await fireFastrackLinkSms({ sql, submission, provider });
      if (outcome.kind === "skipped") {
        skipped++;
        const reason = outcome.reason ?? "unknown";
        skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
      } else if (outcome.result.ok) {
        sent++;
      } else {
        failed++;
      }
    } catch (err) {
      console.error(`sms-fastrack-prompt-cron per-row fail for submission ${submissionId}:`, String(err));
      failed++;
    }
  }

  return json({
    ok: true,
    scanned: submissionIds.length,
    sent,
    skipped,
    failed,
    skipped_reasons: skippedReasons,
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
