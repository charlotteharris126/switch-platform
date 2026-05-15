// Edge Function: email-presumed-flipped-cron
//
// Daily cron at 07:00 UTC. Scans for crm.enrolments rows that were
// flipped to presumed_enrolled / presumed_employer_signed by the
// auto-flip cron in the previous 24h and haven't been notified yet.
// Sends ONE batched email per provider listing every newly-flipped
// lead, telling them they've got 7 days to dispute or update before
// the lead locks in for billing.
//
// Why it exists:
//   The auto-flip cron (crm.run_enrolment_auto_flip, migration 0129)
//   moves untouched Open leads to a Presumed state at the provider's
//   sla_presumed_flip_days threshold. Without a confirmation email the
//   provider may not realise it's happened and miss the 7-day dispute
//   window. This cron closes that gap.
//
// Channel: transactional (operational, contract-basis).
// Recipient: provider contact_email + cc_emails. NOT the learner / employer.
// Idempotency: one email_log row per (submission_id, 'provider_presumed_flipped').
// Template: BREVO_TEMPLATE_PROVIDER_PRESUMED_FLIPPED (Wren to create).
//           Falls back to skipping silently if env var unset.
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
  flipped_at: string;
  dispute_deadline_at: string;
  enrolment_status: "presumed_enrolled" | "presumed_employer_signed";
  course_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company_name: string | null;
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

  // Auth.
  const expected = Deno.env.get("AUDIT_SHARED_SECRET");
  const provided = req.headers.get("x-audit-key");
  if (!expected || !provided || expected !== provided) {
    return json({ error: "unauthorized" }, 401);
  }

  const templateId = Number(Deno.env.get("BREVO_TEMPLATE_PROVIDER_PRESUMED_FLIPPED"));
  if (!templateId) {
    return json({
      ok: true,
      candidates: 0,
      providers_emailed: 0,
      leads_notified: 0,
      reason: "BREVO_TEMPLATE_PROVIDER_PRESUMED_FLIPPED env not set; cron is dormant until Wren creates the template and Charlotte sets the env var.",
    }, 200);
  }

  // Candidate query.
  // - enrolment.status is one of the two presumed states
  // - status_updated_at is within the last 26h (gives a safety window in
  //   case the auto-flip cron drifted; idempotency check below catches
  //   anyone we already notified)
  // - no provider_presumed_flipped email_log row for this submission yet
  // - lead alive (not archived, not DQ)
  // - provider active + has contact email
  let candidates: CandidateRow[];
  try {
    candidates = await sql<CandidateRow[]>`
      SELECT
        e.submission_id,
        e.id AS enrolment_id,
        e.provider_id,
        e.status_updated_at AS flipped_at,
        e.dispute_deadline_at,
        e.status AS enrolment_status,
        s.course_id,
        s.first_name,
        s.last_name,
        s.email,
        s.company_name,
        p.company_name AS provider_company_name,
        p.contact_email AS provider_contact_email,
        p.contact_name AS provider_contact_name,
        coalesce(p.cc_emails, ARRAY[]::text[]) AS provider_cc_emails
      FROM crm.enrolments e
      JOIN leads.submissions s ON s.id = e.submission_id
      JOIN crm.providers p ON p.provider_id = e.provider_id
      WHERE e.status IN ('presumed_enrolled', 'presumed_employer_signed')
        AND e.status_updated_at > now() - interval '26 hours'
        AND s.is_dq = false
        AND s.archived_at IS NULL
        AND p.contact_email IS NOT NULL
        AND p.contact_email <> ''
        AND p.active = true
        AND p.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM crm.email_log el
           WHERE el.submission_id = e.submission_id
             AND el.email_type = 'provider_presumed_flipped'
             AND el.status IN ('queued','sent','delivered','opened','clicked')
        )
      ORDER BY e.provider_id, e.status_updated_at
      LIMIT 500
    `;
  } catch (err) {
    console.error("candidate query failed:", String(err));
    return json({ error: `candidate query: ${String(err)}` }, 500);
  }

  // Group by provider.
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

  for (const batch of batches.values()) {
    // Send one email per provider. The "primary" log row is keyed to the
    // first lead in the batch (matches the warning-cron pattern); we
    // also insert log rows for every lead in the batch so idempotency
    // is per-submission.
    const primaryLead = batch.leads[0];
    const result = await sendTransactional({
      sql,
      templateId,
      recipient: { email: batch.contact_email, name: batch.contact_name ?? batch.company_name },
      submissionId: primaryLead.submission_id,
      emailType: "provider_presumed_flipped",
      brand: "switchleads_leads",
      params: {
        PROVIDER_NAME: batch.contact_name ?? batch.company_name,
        COMPANY_NAME: batch.company_name,
        COUNT: batch.leads.length,
        LEADS_HTML: renderLeadsHtml(batch.leads),
        DISPUTE_DEADLINE: new Date(primaryLead.dispute_deadline_at).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "long",
        }),
      },
    });

    if (result.ok && result.status === "sent") {
      sentBatches += 1;
      sentLeads += batch.leads.length;
      outcomes.push({ provider_id: batch.provider_id, lead_count: batch.leads.length, status: "sent" });
      // Log idempotency rows for every additional lead in the batch.
      for (const lead of batch.leads.slice(1)) {
        try {
          await sql.begin(async (trx) => {
            await trx`SET LOCAL ROLE functions_writer`;
            await trx`
              INSERT INTO crm.email_log (
                submission_id, email_type, channel, template_id, recipient_email,
                status, sent_at, metadata
              ) VALUES (
                ${lead.submission_id},
                'provider_presumed_flipped',
                'transactional',
                ${String(templateId)},
                ${batch.contact_email},
                'sent',
                now(),
                ${trx.json({ batched_with_primary: primaryLead.submission_id })}
              )
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
    await new Promise((r) => setTimeout(r, THROTTLE_MS));
  }

  return json({
    candidates: candidates.length,
    providers_emailed: sentBatches,
    leads_notified: sentLeads,
    leads_skipped: skippedLeads,
    leads_failed: failedLeads,
    outcomes,
  }, 200);
});

function renderLeadsHtml(leads: CandidateRow[]): string {
  const rows = leads.map((l) => {
    const name = [l.first_name, l.last_name].filter(Boolean).join(" ") || "(no name)";
    const subjectLabel = l.company_name ?? l.course_id ?? "";
    const isEmployer = l.enrolment_status === "presumed_employer_signed";
    const stateLabel = isEmployer ? "Presumed signed" : "Presumed enrolled";
    return `
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid #eee">${escapeHtml(name)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee">${escapeHtml(l.email ?? "")}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee">${escapeHtml(subjectLabel)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee">${stateLabel}</td>
      </tr>`;
  }).join("");
  return `
    <table style="border-collapse:collapse;width:100%;font-size:14px;font-family:Inter,Arial,sans-serif">
      <thead>
        <tr style="background:#f4f1ed">
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #11242e">Name</th>
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #11242e">Email</th>
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #11242e">Course / Company</th>
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #11242e">Now at</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c] ?? c));
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
