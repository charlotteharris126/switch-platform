// Edge Function: email-presumed-warning-cron
//
// Daily cron at 05:00 UTC. Scans for routed leads in the day-12-to-14
// window with status='open' and no warning sent yet. Groups by provider
// and sends ONE email per provider listing all their affected leads, two
// working days ahead of the 14-day auto-flip that would mark them
// presumed_enrolled.
//
// Why this exists: the auto-flip cron (migration 0023, paused 2026-05-06
// migration 0080) silently flips open leads to presumed_enrolled at day 14,
// triggering the 7-day dispute clock and ultimately billing. Providers had
// no notice this would happen, leading to operationally premature flips
// (Sam@CD, Ruby/Laura/Raveena@WYK, Lana@EMS, all reverted 2026-05-06). This
// warning gives 2 working days for providers to:
//   - Update status to 'enrolled' / 'cannot_reach' / 'lost' (prevents flip)
//   - Confirm the auto-flip is correct (then it fires day 14 as normal)
//
// Once this is live + verified for a few days, the auto-flip cron can be
// re-enabled with provider awareness in place.
//
// Recipient: provider.contact_email + cc_emails. NOT the learner.
// Channel: transactional (operational message to a signed pilot provider,
//          contract-basis communication). No marketing consent gating.
// Idempotency: one email_log row per (submission_id, 'provider_presumed_warning').
//          A lead in the 12-14 window for 2 days only gets warned once.
//
// Template: BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING (Charlotte creates).
//          Expects params: PROVIDER_NAME, COUNT, LEADS_HTML, FLIP_DATE.
//          Falls back to skipping silently if env var unset (so cron can
//          deploy before the template exists).
//
// Auth: x-audit-key / AUDIT_SHARED_SECRET. Deploy with --no-verify-jwt.

import postgres from "npm:postgres@3";
import { sendTransactional } from "../_shared/brevo.ts";

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

const THROTTLE_MS = 250;

interface CandidateRow {
  submission_id: number;
  enrolment_id: number;
  provider_id: string;
  routed_at: string;
  course_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  days_routed: number;
  // Provider info
  provider_company_name: string;
  provider_contact_email: string;
  provider_contact_name: string | null;
  provider_cc_emails: string[];
}

interface PerProviderBatch {
  provider_id: string;
  company_name: string;
  contact_email: string;
  contact_name: string | null;
  cc_emails: string[];
  leads: CandidateRow[];
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

  const templateId = parseEnvInt("BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING");
  if (templateId == null) {
    return json({
      candidates: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      reason: "BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING env not set; cron is dormant until Charlotte creates the template and sets the env var.",
    }, 200);
  }

  // Candidate query.
  // - status='open' (auto-flip would catch only these)
  // - routed 12-14 days ago (window starts at day-12, ends day-14 when auto-flip fires)
  // - no provider_presumed_warning row in email_log for this submission yet
  // - lead is alive (not archived, not DQ)
  // - provider has contact_email (skip silently if unset)
  let candidates: CandidateRow[];
  try {
    candidates = await sql<CandidateRow[]>`
      SELECT
        rl.submission_id,
        e.id AS enrolment_id,
        rl.provider_id,
        rl.routed_at,
        s.course_id,
        s.first_name,
        s.last_name,
        s.email,
        EXTRACT(DAY FROM now() - rl.routed_at)::int AS days_routed,
        p.company_name AS provider_company_name,
        p.contact_email AS provider_contact_email,
        p.contact_name AS provider_contact_name,
        coalesce(p.cc_emails, ARRAY[]::text[]) AS provider_cc_emails
      FROM leads.routing_log rl
      JOIN crm.enrolments e
        ON e.submission_id = rl.submission_id AND e.provider_id = rl.provider_id
      JOIN leads.submissions s ON s.id = rl.submission_id
      JOIN crm.providers p ON p.provider_id = rl.provider_id
      WHERE rl.routed_at < now() - interval '12 days'
        AND rl.routed_at > now() - interval '14 days'
        AND e.status = 'open'
        AND s.is_dq = false
        AND s.archived_at IS NULL
        AND p.contact_email IS NOT NULL
        AND p.contact_email <> ''
        AND p.active = true
        AND p.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM crm.email_log el
           WHERE el.submission_id = rl.submission_id
             AND el.email_type = 'provider_presumed_warning'
             AND el.status IN ('queued','sent','delivered','opened','clicked')
        )
      ORDER BY rl.provider_id, rl.routed_at
      LIMIT 500
    `;
  } catch (err) {
    console.error("candidate query failed:", String(err));
    return json({ error: `candidate query: ${String(err)}` }, 500);
  }

  // Group by provider
  const batches = new Map<string, PerProviderBatch>();
  for (const c of candidates) {
    if (!batches.has(c.provider_id)) {
      batches.set(c.provider_id, {
        provider_id: c.provider_id,
        company_name: c.provider_company_name,
        contact_email: c.provider_contact_email,
        contact_name: c.provider_contact_name,
        cc_emails: c.provider_cc_emails,
        leads: [],
      });
    }
    batches.get(c.provider_id)!.leads.push(c);
  }

  let sentBatches = 0;
  let sentLeads = 0;
  let skippedLeads = 0;
  let failedLeads = 0;
  const outcomes: Array<{ provider_id: string; lead_count: number; status: string; error?: string }> = [];

  let i = 0;
  for (const batch of batches.values()) {
    if (i++ > 0) await sleep(THROTTLE_MS);

    const flipDate = new Date(Date.now() + 2 * 24 * 3600 * 1000)
      .toLocaleDateString("en-GB", { day: "numeric", month: "long" });
    const leadsHtml = renderLeadsHtml(batch.leads);

    // One transactional send per provider, with submission_id of the FIRST
    // affected lead as the per-row anchor (sendTransactional's idempotency
    // is per submission). We log additional rows for the other leads in
    // the batch directly so each lead has its own warning record.
    const anchorLead = batch.leads[0];
    const recipientName = batch.contact_name ?? batch.company_name;

    // sendTransactional sends to the primary recipient only (no CC support).
    // cc_emails on the provider record are not used for v1 — the primary
    // contact_email is the operational owner and can forward internally.
    // Add CC support to sendTransactional later if a provider asks for it.
    const result = await sendTransactional({
      sql,
      templateId,
      recipient: { email: batch.contact_email, name: recipientName },
      params: {
        PROVIDER_NAME: batch.company_name,
        CONTACT_NAME: batch.contact_name ?? "",
        COUNT: batch.leads.length,
        LEADS_HTML: leadsHtml,
        FLIP_DATE: flipDate,
      },
      submissionId: anchorLead.submission_id,
      emailType: "provider_presumed_warning",
      brand: "switchleads",
      tags: ["provider_presumed_warning", "cron", batch.provider_id],
    });

    if (result.ok && result.status === "sent") {
      sentBatches++;
      sentLeads += batch.leads.length;
      outcomes.push({ provider_id: batch.provider_id, lead_count: batch.leads.length, status: "sent" });

      // Log warning rows for the OTHER leads in the batch (not the anchor —
      // sendTransactional already logged that). Each lead gets one row so
      // the per-lead idempotency holds for the next cron run.
      for (let j = 1; j < batch.leads.length; j++) {
        const lead = batch.leads[j];
        try {
          await sql.begin(async (trx) => {
            await trx`SET LOCAL ROLE functions_writer`;
            await trx`
              INSERT INTO crm.email_log
                (submission_id, email_type, channel, template_id,
                 recipient_email, triggered_at, sent_at, status, metadata)
              VALUES
                (${lead.submission_id}, 'provider_presumed_warning',
                 'transactional', ${String(templateId)},
                 ${batch.contact_email}, now(), now(), 'sent',
                 ${trx.json({
                   batch_anchor_submission_id: anchorLead.submission_id,
                   batch_size: batch.leads.length,
                   provider_id: batch.provider_id,
                 })})
            `;
          });
        } catch (err) {
          console.error(`additional email_log insert failed for sub ${lead.submission_id}:`, String(err));
        }
      }
    } else if (result.status === "skipped_duplicate") {
      skippedLeads += batch.leads.length;
      outcomes.push({ provider_id: batch.provider_id, lead_count: batch.leads.length, status: "skipped_duplicate" });
    } else {
      failedLeads += batch.leads.length;
      outcomes.push({ provider_id: batch.provider_id, lead_count: batch.leads.length, status: "failed", error: result.error });
    }
  }

  return json({
    candidates: candidates.length,
    providers_emailed: sentBatches,
    leads_warned: sentLeads,
    leads_skipped: skippedLeads,
    leads_failed: failedLeads,
    outcomes,
  }, 200);
});

function renderLeadsHtml(leads: CandidateRow[]): string {
  const rows = leads.map((l) => {
    const name = [l.first_name, l.last_name].filter(Boolean).join(" ") || "(no name)";
    const flipDateStr = new Date(new Date(l.routed_at).getTime() + 14 * 24 * 3600 * 1000)
      .toLocaleDateString("en-GB", { day: "numeric", month: "long" });
    return `
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid #eee">${escapeHtml(name)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee">${escapeHtml(l.email ?? "")}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee">${escapeHtml(l.course_id ?? "")}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:center">${l.days_routed}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee">${flipDateStr}</td>
      </tr>`;
  }).join("");
  return `
    <table style="border-collapse:collapse;width:100%;font-size:14px;font-family:Inter,Arial,sans-serif">
      <thead>
        <tr style="background:#f4f1ed">
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #11242e">Name</th>
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #11242e">Email</th>
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #11242e">Course</th>
          <th style="padding:8px 12px;text-align:center;border-bottom:2px solid #11242e">Days</th>
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #11242e">Auto-mark date</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseEnvInt(name: string): number | null {
  const raw = Deno.env.get(name);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
