// Shared core for the Switchable-for-Business employer-lead pipeline.
//
// Two receivers import this module so both produce byte-identical
// leads.submissions rows, routing_log rows, open enrolments, sheet appends
// and Brevo U1/U2 sends:
//   - netlify-employer-lead-router      (on-site /business/ form, form_name gate, CAPI on)
//   - meta-instant-employer-lead-router (Meta Instant Form via Zapier/Make, secret auth, CAPI off)
//
// The ONLY per-receiver differences live in the thin handlers:
//   1. inbound auth (form_name match vs shared-secret header)
//   2. source_form value (passed into processEmployerLead)
//   3. whether the owned server-side Meta CAPI Lead fires (fireCapi flag)
//
// Everything else — normalisation, the INSERT + routing_log + ensure_open_enrolment
// transaction, the sheet/U1/U2 fan-out, the audit write — is shared here so it can
// never drift between the two entry points. Changing anything in this file means
// redeploying BOTH functions (see feedback_shared_module_change_needs_each_function_redeployed).
//
// Role: connects via Supabase's auto-injected SUPABASE_DB_URL (postgres superuser)
// and drops to scoped `functions_writer` at the start of every transaction.

import postgres from "npm:postgres@3";
import {
  sendBrevoEmail,
  sendTransactional,
  upsertBrevoContact,
  type BrevoAttributes,
} from "./brevo.ts";
import { logCapiSend, sendCapiLead } from "./meta-capi.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error(
    "SUPABASE_DB_URL is not set. This should be auto-injected by Supabase for every Edge Function.",
  );
}

export const RIVERSIDE_PROVIDER_ID = "riverside-training";
// B2B Meta pixel for the owned server-side CAPI Lead send (only fired by the
// on-site Netlify receiver — the Instant Form path sets fireCapi=false because
// Meta already records the lead natively). Env-overridable; defaults to the
// live B2B pixel id. See platform/docs/capi-server-side-scoping-2026-06-15.md.
const META_PIXEL_ID_B2B = Deno.env.get("META_PIXEL_ID_B2B") ?? "1386293849929367";
const BREVO_TEMPLATE_U1_EMPLOYER = "BREVO_TEMPLATE_U1_EMPLOYER";

export const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface EmployerSubmissionRow {
  // Discriminator + identifiers
  schema_version: string;
  lead_type: "employer_apprenticeship";
  source_form: string;
  // Routing fields
  primary_routed_to: string | null;
  routing_outcome: "routed" | "disqualified";
  routing_outcome_hint: string | null;
  routed_at: string | null;
  // Submitter contact
  first_name: string | null;
  last_name: string | null;
  email: string;
  phone: string | null;
  role_title: string | null;
  // Company + apprenticeship context
  company_name: string | null;
  company_size_band: string | null;
  sector: string | null;
  levy_status: string | null;
  interest: string | null;
  urgency: string | null;
  candidate_in_mind: string | null;
  existing_apprentices: string | null;
  headcount_estimate: string | null;
  standards_interested: string | null;
  focus_area: string | null;
  additional_notes: string | null;
  ern: string;
  // Consent
  terms_accepted: boolean;
  terms_accepted_at: string | null;
  marketing_opt_in: boolean;
  // Tracking
  page_url: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  fbclid: string | null;
  gclid: string | null;
  referrer: string | null;
  event_id: string | null;
  fbp: string | null;
  fbc: string | null;
  experiment_id: string | null;
  experiment_variant: string | null;
  // Raw payload — entire body archived for audit
  raw_payload: JsonValue;
}

export interface ProcessResult {
  submissionId: number;
  outcome: "routed" | "disqualified";
  // Post-route side effects (sheet + U1 + U2 + audit + optional CAPI). null for
  // DQ leads. The handler passes this to EdgeRuntime.waitUntil so slow Brevo
  // never times out the inbound webhook.
  task: Promise<void> | null;
}

// ---------------------------------------------------------------------------
// Public entry point — normalise → insert → build fan-out task
// ---------------------------------------------------------------------------

export async function processEmployerLead(
  data: Record<string, JsonValue>,
  rawBody: JsonValue,
  opts: { sourceForm: string; fireCapi: boolean },
): Promise<ProcessResult> {
  const row = normalise(data, rawBody, opts.sourceForm);
  const submissionId = await insertEmployerLead(row);

  if (row.routing_outcome === "disqualified") {
    // DQ only fires on truly malformed payloads (no email / no company). No
    // email follow-up — by definition we either can't reach them or it's a bot.
    // Row persisted with routing_outcome='disqualified' for audit.
    return { submissionId, outcome: "disqualified", task: null };
  }

  const task = buildPostRouteTask(submissionId, row, opts.fireCapi);
  return { submissionId, outcome: "routed", task };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function normalise(
  data: Record<string, JsonValue>,
  rawBody: JsonValue,
  sourceForm: string,
): EmployerSubmissionRow {
  const email = trimLowerOrNull(strOrNull(data.email));
  const company_name = trimOrNull(strOrNull(data.company_name));
  const full_name = strOrNull(data.full_name) ?? "";
  const [first_name, last_name] = splitName(full_name);

  // Minimal DQ: missing email or missing company name → disqualified.
  // (Companies House lookup deferred to v1.1 per the spec.)
  let routing_outcome: "routed" | "disqualified" = "routed";
  if (!email || !company_name) {
    routing_outcome = "disqualified";
  }

  const terms_accepted = strOrNull(data.terms_accepted) === "true" || data.terms_accepted === true;
  const marketing_opt_in =
    strOrNull(data.marketing_opt_in) === "true" || data.marketing_opt_in === true;
  const now = new Date().toISOString();

  return {
    schema_version: strOrNull(data.schema_version) ?? "1.0",
    lead_type: "employer_apprenticeship",
    source_form: sourceForm,
    primary_routed_to: routing_outcome === "routed" ? RIVERSIDE_PROVIDER_ID : null,
    routing_outcome,
    routing_outcome_hint: strOrNull(data.routing_outcome_hint),
    routed_at: routing_outcome === "routed" ? now : null,
    first_name,
    last_name,
    email: email ?? "",
    phone: trimOrNull(strOrNull(data.phone)),
    role_title: trimOrNull(strOrNull(data.role_title)),
    company_name,
    company_size_band: strOrNull(data.company_size_band),
    sector: strOrNull(data.sector),
    levy_status: strOrNull(data.levy_status),
    interest: strOrNull(data.interest),
    urgency: strOrNull(data.urgency),
    candidate_in_mind: strOrNull(data.candidate_in_mind),
    existing_apprentices: strOrNull(data.existing_apprentices),
    headcount_estimate: strOrNull(data.headcount_estimate),
    standards_interested: strOrNull(data.standards_interested) ?? "General enquiry",
    focus_area: strOrNull(data.focus_area),
    additional_notes: trimOrNull(strOrNull(data.additional_notes)),
    ern: strOrNull(data.ern) ?? "",
    terms_accepted,
    terms_accepted_at: terms_accepted ? now : null,
    marketing_opt_in,
    page_url: strOrNull(data.page_url),
    utm_source: strOrNull(data.utm_source),
    utm_medium: strOrNull(data.utm_medium),
    utm_campaign: strOrNull(data.utm_campaign),
    utm_content: strOrNull(data.utm_content),
    fbclid: strOrNull(data.fbclid),
    gclid: strOrNull(data.gclid),
    referrer: strOrNull(data.referrer_url) ?? strOrNull(data.referrer),
    event_id: trimOrNull(strOrNull(data.event_id)),
    fbp: trimOrNull(strOrNull(data.fbp)),
    fbc: trimOrNull(strOrNull(data.fbc)),
    experiment_id: trimOrNull(strOrNull(data.experiment_id)),
    experiment_variant: trimOrNull(strOrNull(data.experiment_variant)),
    raw_payload: rawBody,
  };
}

function splitName(full: string): [string | null, string | null] {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [null, null];
  if (parts.length === 1) return [parts[0], null];
  return [parts[0], parts.slice(1).join(" ")];
}

// ---------------------------------------------------------------------------
// DB insert
// ---------------------------------------------------------------------------

async function insertEmployerLead(row: EmployerSubmissionRow): Promise<number> {
  return await sql.begin(async (tx: postgres.TransactionSql) => {
    await tx`SET LOCAL ROLE functions_writer`;

    const providerIds = row.routing_outcome === "routed" ? [RIVERSIDE_PROVIDER_ID] : [];
    const nowIso = new Date().toISOString();
    const [inserted] = await tx<Array<{ id: number }>>`
      INSERT INTO leads.submissions (
        schema_version, submitted_at, lead_type, source_form, primary_routed_to, routing_outcome,
        routing_outcome_hint, routed_at, provider_ids,
        first_name, last_name, email, phone, role_title,
        company_name, company_size_band, sector, levy_status,
        interest, urgency, candidate_in_mind, existing_apprentices,
        headcount_estimate, standards_interested, focus_area, additional_notes, ern,
        terms_accepted, terms_accepted_at, marketing_opt_in,
        page_url, utm_source, utm_medium, utm_campaign, utm_content,
        fbclid, gclid, referrer, event_id, fbp, fbc, experiment_id, experiment_variant, raw_payload, is_dq
      ) VALUES (
        ${row.schema_version}, ${nowIso}, ${row.lead_type}, ${row.source_form}, ${row.primary_routed_to}, ${row.routing_outcome},
        ${row.routing_outcome_hint}, ${row.routed_at}, ${providerIds},
        ${row.first_name}, ${row.last_name}, ${row.email}, ${row.phone}, ${row.role_title},
        ${row.company_name}, ${row.company_size_band}, ${row.sector}, ${row.levy_status},
        ${row.interest}, ${row.urgency}, ${row.candidate_in_mind}, ${row.existing_apprentices},
        ${row.headcount_estimate}, ${row.standards_interested}, ${row.focus_area}, ${row.additional_notes}, ${row.ern},
        ${row.terms_accepted}, ${row.terms_accepted_at}, ${row.marketing_opt_in},
        ${row.page_url}, ${row.utm_source}, ${row.utm_medium}, ${row.utm_campaign}, ${row.utm_content},
        ${row.fbclid}, ${row.gclid}, ${row.referrer}, ${row.event_id}, ${row.fbp}, ${row.fbc}, ${row.experiment_id}, ${row.experiment_variant}, ${tx.json(row.raw_payload)}, ${row.routing_outcome === "disqualified"}
      )
      RETURNING id
    `;

    if (row.routing_outcome === "routed") {
      const logRows = await tx<Array<{ id: number }>>`
        INSERT INTO leads.routing_log (
          submission_id, provider_id, route_reason, delivery_method, delivery_status
        ) VALUES (
          ${inserted.id}, ${RIVERSIDE_PROVIDER_ID}, 'primary', 'sheet_webhook', 'sent'
        )
        RETURNING id
      `;
      const routingLogId = Number(logRows[0].id);
      await tx`
        SELECT crm.ensure_open_enrolment(
          ${inserted.id},
          ${routingLogId},
          ${RIVERSIDE_PROVIDER_ID}
        )
      `;
    }

    return inserted.id;
  });
}

// ---------------------------------------------------------------------------
// Post-route fan-out (sheet + U1 + U2 + audit + optional CAPI)
// ---------------------------------------------------------------------------

function buildPostRouteTask(
  insertedId: number,
  row: EmployerSubmissionRow,
  fireCapi: boolean,
): Promise<void> {
  return (async () => {
    const results = await Promise.allSettled([
      appendToRiversideSheet(insertedId, row),
      (async () => {
        await upsertEmployerInBrevo(insertedId, row);
        await sendEmployerAckU1(insertedId, row);
      })(),
      sendProviderNotifyU2(insertedId, row),
    ]);
    const legNames = ["sheet-append", "U1-employer", "U2-provider"];
    results.forEach((result, idx) => {
      if (result.status === "rejected") {
        console.error(
          `post-route leg ${legNames[idx]} failed (submission ${insertedId}):`,
          describeError(result.reason),
        );
      }
    });

    const sheetAppended = results[0].status === "fulfilled";
    const employerAcked = results[1].status === "fulfilled";
    const providerNotified = results[2].status === "fulfilled";
    try {
      await sql`
        SELECT public.log_system_action_v1(
          ${"system:auto_route:lead_router"},
          ${"auto_route_lead"},
          ${"leads.submissions"},
          ${String(insertedId)},
          ${null},
          ${sql.json({ primary_routed_to: RIVERSIDE_PROVIDER_ID, routed_at: row.routed_at })},
          ${sql.json({
            trigger: "auto_route",
            lead_type: row.lead_type,
            source_form: row.source_form,
            provider_id: RIVERSIDE_PROVIDER_ID,
            sheet_appended: sheetAppended,
            provider_notified: providerNotified,
            employer_ack_sent: employerAcked,
          })}
        )
      `;
    } catch (err) {
      console.error("audit log write failed:", describeError(err));
    }

    // Owned server-side Meta CAPI Lead — only for the on-site Netlify path
    // (fireCapi=true). Instant Form submissions are recorded natively by Meta,
    // so firing here would double-count. Never throws (must not break the task).
    if (fireCapi) {
      try {
        const capi = await sendCapiLead({
          brand: "b2b",
          pixelId: META_PIXEL_ID_B2B,
          eventId: row.event_id,
          eventSourceUrl: row.page_url,
          email: row.email,
          firstName: row.first_name,
          lastName: row.last_name,
          phone: row.phone,
          externalId: String(insertedId),
          fbc: row.fbc,
          fbp: row.fbp,
          fbclid: row.fbclid,
          value: 400, // Employer Signed pilot fee, matches the Stape tag
          currency: "GBP",
          contentCategory: "employer_lead",
        });
        await logCapiSend(sql, {
          submissionId: insertedId,
          brand: "b2b",
          pixelId: META_PIXEL_ID_B2B,
          eventId: row.event_id,
          result: capi,
        });
        if (!capi.ok) {
          console.error(`CAPI Lead send not ok (submission ${insertedId}):`, capi.errorBody);
        }
      } catch (err) {
        console.error("CAPI leg failed:", describeError(err));
      }
    }
  })().catch((e) => console.error("post-route fan-out failed:", describeError(e)));
}

async function appendToRiversideSheet(submissionId: number, row: EmployerSubmissionRow): Promise<void> {
  // Riverside is portal-only since migration 0209 (sheet_webhook_url NULLed),
  // so this early-returns for Riverside today. Kept intact for any future
  // sheet-backed provider on the employer route.
  const [providerRow] = await sql<Array<{ sheet_webhook_url: string | null }>>`
    SELECT sheet_webhook_url FROM crm.providers WHERE provider_id = ${RIVERSIDE_PROVIDER_ID}
  `;
  const url = providerRow?.sheet_webhook_url;
  if (!url) {
    console.warn("Riverside sheet_webhook_url not set on crm.providers — skipping sheet append");
    return;
  }
  const token = Deno.env.get("SHEETS_APPEND_TOKEN");
  if (!token) {
    console.warn("SHEETS_APPEND_TOKEN not set — skipping sheet append");
    return;
  }

  const fullName = [row.first_name, row.last_name].filter(Boolean).join(" ");
  const body = {
    token,
    mode: "append",
    submission_id: submissionId,
    submitted_at: new Date().toISOString(),
    name: fullName,
    first_name: row.first_name ?? "",
    last_name: row.last_name ?? "",
    email: row.email,
    phone: row.phone ?? "",
    role_title: row.role_title ?? "",
    company_name: row.company_name ?? "",
    sector: row.sector ?? "",
    company_size_band: row.company_size_band ?? "",
    levy_status: row.levy_status ?? "",
    interest: row.interest ?? "",
    candidate_in_mind: row.candidate_in_mind ?? "",
    urgency: row.urgency ?? "",
    headcount_estimate: row.headcount_estimate ?? "",
    existing_apprentices: row.existing_apprentices ?? "",
    standards_interested: row.standards_interested ?? "",
    additional_notes: row.additional_notes ?? "",
    status: "",
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`sheet append HTTP ${res.status}: ${await res.text()}`);
  }
  const responseText = await res.text();
  let parsed: { ok?: boolean; error?: string } | null = null;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error(`sheet append: unparseable response: ${responseText.slice(0, 300)}`);
  }
  if (!parsed?.ok) {
    throw new Error(`sheet append rejected: ${parsed?.error ?? responseText.slice(0, 300)}`);
  }
}

async function upsertEmployerInBrevo(submissionId: number, row: EmployerSubmissionRow): Promise<void> {
  if (!row.email) return;

  let providerName = "";
  let providerTrustLine = "";
  if (row.primary_routed_to) {
    try {
      const providerRows = await sql<Array<{ company_name: string | null; b2b_trust_line: string | null }>>`
        SELECT company_name, b2b_trust_line
          FROM crm.providers
         WHERE provider_id = ${row.primary_routed_to}
         LIMIT 1
      `;
      const provider = providerRows[0];
      providerName = provider?.company_name ?? "";
      providerTrustLine = provider?.b2b_trust_line ?? "";
    } catch (err) {
      console.error(
        `provider lookup failed (submission ${submissionId}, provider ${row.primary_routed_to}): ${describeError(err)}`,
      );
    }
  }

  const attributes: BrevoAttributes = {
    FIRSTNAME: row.first_name ?? "",
    LASTNAME: row.last_name ?? "",
    B2B_COMPANY_NAME: row.company_name ?? "",
    B2B_ROLE_TITLE: row.role_title ?? "",
    B2B_INTEREST: row.interest ?? "",
    B2B_CANDIDATE_IN_MIND: row.candidate_in_mind ?? "",
    B2B_URGENCY: row.urgency ?? "",
    B2B_LEVY_STATUS: row.levy_status ?? "",
    B2B_SECTOR: row.sector ?? "",
    B2B_COMPANY_SIZE: row.company_size_band ?? "",
    B2B_EXISTING_APPRENTICES: row.existing_apprentices ?? "",
    B2B_HEADCOUNT_ESTIMATE: row.headcount_estimate ?? "",
    B2B_STANDARD: row.standards_interested ?? "",
    B2B_LEAD_TYPE: "employer_apprenticeship",
    B2B_MATCHED_PROVIDER: row.routing_outcome === "routed" ? "riverside" : "",
    B2B_PROVIDER_NAME: providerName,
    B2B_PROVIDER_TRUST_LINE: providerTrustLine,
    B2B_ROUTING_OUTCOME: row.routing_outcome,
    B2B_FIRST_SUBMISSION_AT: new Date().toISOString(),
  };

  const result = await upsertBrevoContact({
    email: row.email,
    attributes,
    marketingOptIn: row.marketing_opt_in,
  });

  if (!result.ok) {
    console.error(
      `upsert employer contact failed (submission ${submissionId}): ${result.error ?? "unknown"}`,
    );
  }
}

async function sendEmployerAckU1(submissionId: number, row: EmployerSubmissionRow): Promise<void> {
  const templateId = Number(Deno.env.get(BREVO_TEMPLATE_U1_EMPLOYER));
  if (!templateId) {
    console.warn(`${BREVO_TEMPLATE_U1_EMPLOYER} not set — skipping U1 employer ack`);
    return;
  }
  if (!row.email) return;
  const recipientName = [row.first_name, row.last_name].filter(Boolean).join(" ") || row.email;
  await sendTransactional({
    sql,
    templateId,
    recipient: { email: row.email, name: recipientName },
    submissionId,
    emailType: "s4b_employer_u1",
    brand: "switchable",
    params: {
      FIRSTNAME: row.first_name ?? "",
      COMPANY: row.company_name ?? "",
      ROLE: row.role_title ?? "",
      SECTOR: row.sector ?? "",
      LEVY_STATUS: row.levy_status ?? "",
      URGENCY: row.urgency ?? "",
      STANDARD: row.standards_interested ?? "",
      SUBMISSION_ID: submissionId,
    },
  });
}

async function sendProviderNotifyU2(submissionId: number, row: EmployerSubmissionRow): Promise<void> {
  // PII-free provider notification (feedback_provider_email_no_pii): lead
  // reference + portal deep-link only. TEST_MODE redirect preserved.
  const testMode = Deno.env.get("TEST_MODE") === "true";
  const ownerTestEmail = Deno.env.get("OWNER_TEST_EMAIL");

  const [providerRow] = await sql<Array<{
    contact_email: string | null;
    contact_name: string | null;
    company_name: string;
    cc_emails: string[] | null;
    portal_enabled: boolean;
    sheet_id: string | null;
  }>>`
    SELECT contact_email, contact_name, company_name, cc_emails, portal_enabled, sheet_id
      FROM crm.providers
     WHERE provider_id = ${RIVERSIDE_PROVIDER_ID}
  `;
  if (!providerRow?.contact_email) {
    console.warn("Riverside contact_email not set on crm.providers — skipping U2 provider notify");
    return;
  }

  let recipientEmail = providerRow.contact_email;
  let recipientName = providerRow.contact_name ?? providerRow.company_name;
  let ccList = providerRow.cc_emails && providerRow.cc_emails.length > 0
    ? providerRow.cc_emails.map((e: string) => ({ email: e }))
    : undefined;
  let subjectPrefix = "";

  if (testMode) {
    if (!ownerTestEmail) {
      console.warn("TEST_MODE=true but OWNER_TEST_EMAIL not set — skipping U2 to avoid hitting provider");
      return;
    }
    recipientEmail = ownerTestEmail;
    recipientName = "Owner (TEST_MODE redirect)";
    ccList = undefined;
    subjectPrefix = "[TEST] ";
    console.log(`TEST_MODE active: U2 redirected to ${ownerTestEmail} (submission ${submissionId})`);
  }

  const leadRef = `#${submissionId}`;
  const portalLink = providerRow.portal_enabled
    ? `https://app.switchleads.co.uk/leads/${submissionId}`
    : null;
  const sheetLink = providerRow.sheet_id
    ? `https://docs.google.com/spreadsheets/d/${providerRow.sheet_id}/edit`
    : null;
  const actionBlock = portalLink && sheetLink
    ? `<p><a href="${portalLink}">Open this lead in your SwitchLeads portal</a></p>
       <p style="font-size:13px;color:#64748b;">Backup: <a href="${sheetLink}">open your sheet</a> if the portal isn't loading.</p>`
    : portalLink
      ? `<p><a href="${portalLink}">Open this lead in your SwitchLeads portal</a></p>`
      : sheetLink
        ? `<p><a href="${sheetLink}">Open your sheet</a></p>`
        : "";
  const contextLine = portalLink
    ? `<p>The lead is at status <strong>open</strong>. Click through to see the employer's details, mark outcomes as you progress, and add notes.</p>`
    : `<p>The lead has been added with status <strong>open</strong>. Please update the status and notes as you work through.</p>`;

  const html = `
    <p>Hi ${providerRow.contact_name ?? "there"},</p>
    <p>You have a new employer enquiry (${leadRef}) ${portalLink ? "ready in your SwitchLeads portal" : "in your SwitchLeads sheet"}.</p>
    ${actionBlock}
    ${contextLine}
    <p>Thanks,<br>SwitchLeads</p>
  `.trim();

  await sendBrevoEmail({
    to: [{ email: recipientEmail, name: recipientName }],
    cc: ccList,
    subject: `${subjectPrefix}New employer enquiry - ${leadRef}`,
    htmlContent: html,
    brand: "switchleads_leads",
    tags: testMode ? ["route-lead", "employer-notification", "test-mode"] : ["route-lead", "employer-notification"],
  });
}

// ---------------------------------------------------------------------------
// Plumbing helpers (shared by both handlers)
// ---------------------------------------------------------------------------

export async function persistDeadLetter(
  payload: JsonValue,
  reason: string,
  source: string,
): Promise<void> {
  try {
    await sql.begin(async (tx: postgres.TransactionSql) => {
      await tx`SET LOCAL ROLE functions_writer`;
      await tx`
        INSERT INTO leads.dead_letter (source, error_context, raw_payload)
        VALUES (${source}, ${reason}, ${tx.json(payload)})
      `;
    });
  } catch (err) {
    console.error("dead_letter INSERT failed:", describeError(err));
  }
}

export function firstTopLevelString(body: Record<string, JsonValue>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function strOrNull(v: JsonValue | undefined): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.length > 0 ? v : null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function trimOrNull(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function trimLowerOrNull(v: string | null): string | null {
  const t = trimOrNull(v);
  return t ? t.toLowerCase() : null;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
