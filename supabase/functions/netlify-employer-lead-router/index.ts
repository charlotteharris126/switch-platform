// Edge Function: netlify-employer-lead-router
// Receives the Netlify Forms outgoing webhook for the Switchable for Business
// employer-lead form (`s4b-employer-lead-v1`). Normalises the payload into
// leads.submissions with lead_type='employer_apprenticeship', appends to the
// Riverside Google Sheet, and fires the U1-employer + U2-provider Brevo
// transactional emails.
//
// v1 design notes (deliberately leaner than netlify-lead-router):
//   - Single hardcoded provider (Riverside) — every routed lead lands with
//     primary_routed_to='riverside-training'. Multi-provider routing is a v2
//     concern once the apprenticeship pilot proves out.
//   - No auto_route_enabled gate, no referral programme, no fastrack path.
//   - Server-side DQ is intentionally minimal: only an obviously-junk
//     submission gate (no email or no company name). Mable's spec called for
//     a Companies House lookup combined with consumer-email-domain matching;
//     that's deferred to v1.1. False negatives in v1 mean Riverside reviews
//     a few low-quality rows; false positives would lose real leads from
//     owner-MDs of small businesses who legitimately use Gmail.
//   - Brevo emails fire as post-response background tasks via
//     EdgeRuntime.waitUntil so slow Brevo can never time out Netlify's
//     webhook (Session 3.3 incident pattern).
//
// Role: connects via Supabase's auto-injected SUPABASE_DB_URL (postgres
// superuser) and drops to scoped `functions_writer` role at the start of
// every transaction via SET LOCAL ROLE.

import postgres from "npm:postgres@3";
import {
  sendBrevoEmail,
  sendTransactional,
  upsertBrevoContact,
  type BrevoAttributes,
} from "../_shared/brevo.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error(
    "SUPABASE_DB_URL is not set. This should be auto-injected by Supabase for every Edge Function.",
  );
}

const RIVERSIDE_PROVIDER_ID = "riverside-training";
// Provider contact email + sheet webhook URL + cc_emails are read from
// crm.providers at send time (same pattern as netlify-lead-router for
// funded providers). Single source of truth, editable via
// /admin/providers/[id]. The U1 Brevo template ID stays in Vault because
// it's per-environment. The provider-facing U2 notification is inline
// HTML (matches funded provider notification in _shared/route-lead.ts).
//
// No UD-employer email in v1: there's no real "not a fit right now" path
// — every legitimate submission routes to Riverside. The only DQ branch
// is truly malformed payloads (missing email entirely) which by
// definition can't be emailed back. Persisted to DB with
// routing_outcome='disqualified' for audit only.
const BREVO_TEMPLATE_U1_EMPLOYER = "BREVO_TEMPLATE_U1_EMPLOYER";

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface EmployerSubmissionRow {
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
  interest: string | null;            // existing column reused for B2B value space
  urgency: string | null;
  candidate_in_mind: string | null;
  existing_apprentices: string | null;
  headcount_estimate: string | null;
  standards_interested: string | null;
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
  // Raw payload — entire body archived for audit
  raw_payload: JsonValue;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let rawBody: JsonValue;
  try {
    rawBody = await req.json();
  } catch (_err) {
    return await persistDeadLetter(null, "Invalid JSON body");
  }

  const body = rawBody as Record<string, JsonValue> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return await persistDeadLetter(rawBody, "Request body is not an object");
  }

  const formName = firstTopLevelString(body, "form_name", "form-name");
  if (formName !== "s4b-employer-lead-v1") {
    return json({ status: "ignored", form_name: formName, reason: "wrong form for employer-lead-router" });
  }

  const data = (body.data ?? body.payload ?? body) as Record<string, JsonValue>;

  const row = normalise(data, rawBody);

  // INSERT with the scoped role.
  let insertedId: number;
  try {
    insertedId = await insertEmployerLead(row);
  } catch (err) {
    console.error("leads.submissions employer INSERT failed:", describeError(err));
    return await persistDeadLetter(rawBody, `INSERT failed: ${describeError(err)}`);
  }

  const runtime = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;

  if (row.routing_outcome === "disqualified") {
    // DQ in v1 only fires on truly malformed payloads (no email / no
    // company). No email follow-up — by definition we either can't reach
    // them (no email) or it's likely a bot. Row persisted with
    // routing_outcome='disqualified' for audit. Owner can review via
    // /admin/leads filtered on is_dq=true if anything legit ever lands
    // here by mistake.
    return json({ status: "ok", submission_id: insertedId, outcome: "disqualified" });
  }

  // Routed path: append to Riverside sheet, U1 to employer, U2 to provider.
  // Each leg's rejection is logged individually so a silent failure on one
  // leg doesn't disappear (previously Promise.allSettled swallowed leg
  // rejections without surfacing them — bit us 2026-05-12 with the sheet
  // append returning {ok:false, error:'unauthorized'}).
  const task = (async () => {
    // U1 leg runs the Brevo contact upsert sequentially BEFORE the
    // transactional send, mirroring the upsertLearnerInBrevo →
    // sendU1Transactional pattern in _shared/route-lead.ts. The upsert
    // lands FIRSTNAME + B2B_* attributes per
    // switchable/site/docs/switchable-for-business/note-for-sasha.md §5
    // so any Brevo Automation triggered by attribute or by U1 send has
    // the namespaced employer attributes available. Failures inside
    // the leg are logged by the per-leg surfacing below.
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
  })().catch((e) => console.error("post-route fan-out failed:", describeError(e)));
  if (runtime?.waitUntil) runtime.waitUntil(task);

  return json({ status: "ok", submission_id: insertedId, outcome: "routed" });
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function normalise(data: Record<string, JsonValue>, rawBody: JsonValue): EmployerSubmissionRow {
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
    source_form: "s4b-employer-lead-v1",
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
    standards_interested: strOrNull(data.standards_interested) ?? "Project Management Level 4",
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

    // `provider_ids` is NOT NULL on leads.submissions; for employer leads
    // we set it to the single Riverside id (routed) or empty array (DQ).
    const providerIds = row.routing_outcome === "routed" ? [RIVERSIDE_PROVIDER_ID] : [];

    // submitted_at is NOT NULL with no DB-side default. created_at has a
    // default of now() so we don't set it explicitly. referral_code is
    // auto-populated by the leads.set_referral_code_default() trigger
    // when the INSERT omits it (migration 0053).
    const nowIso = new Date().toISOString();
    const [inserted] = await tx<Array<{ id: number }>>`
      INSERT INTO leads.submissions (
        schema_version, submitted_at, lead_type, source_form, primary_routed_to, routing_outcome,
        routing_outcome_hint, routed_at, provider_ids,
        first_name, last_name, email, phone, role_title,
        company_name, company_size_band, sector, levy_status,
        interest, urgency, candidate_in_mind, existing_apprentices,
        headcount_estimate, standards_interested, additional_notes, ern,
        terms_accepted, terms_accepted_at, marketing_opt_in,
        page_url, utm_source, utm_medium, utm_campaign, utm_content,
        fbclid, gclid, referrer, raw_payload, is_dq
      ) VALUES (
        ${row.schema_version}, ${nowIso}, ${row.lead_type}, ${row.source_form}, ${row.primary_routed_to}, ${row.routing_outcome},
        ${row.routing_outcome_hint}, ${row.routed_at}, ${providerIds},
        ${row.first_name}, ${row.last_name}, ${row.email}, ${row.phone}, ${row.role_title},
        ${row.company_name}, ${row.company_size_band}, ${row.sector}, ${row.levy_status},
        ${row.interest}, ${row.urgency}, ${row.candidate_in_mind}, ${row.existing_apprentices},
        ${row.headcount_estimate}, ${row.standards_interested}, ${row.additional_notes}, ${row.ern},
        ${row.terms_accepted}, ${row.terms_accepted_at}, ${row.marketing_opt_in},
        ${row.page_url}, ${row.utm_source}, ${row.utm_medium}, ${row.utm_campaign}, ${row.utm_content},
        ${row.fbclid}, ${row.gclid}, ${row.referrer}, ${tx.json(row.raw_payload)}, ${row.routing_outcome === "disqualified"}
      )
      RETURNING id
    `;

    if (row.routing_outcome === "routed") {
      // Match the canonical route-lead pattern in _shared/route-lead.ts:
      // routing_log row + ensure_open_enrolment so the provider portal's
      // /provider/leads + lead-detail queries find a row to render
      // against. Without the enrolment row, Riverside would see the lead
      // listed but couldn't mark an outcome.
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
// Sheet append + email helpers
// ---------------------------------------------------------------------------

async function appendToRiversideSheet(submissionId: number, row: EmployerSubmissionRow): Promise<void> {
  // Mirror the canonical sheet-append shape from _shared/route-lead.ts:
  //   - token at top level (Apps Script v2 rejects with `unauthorized` if missing)
  //   - payload keys are FIELD_MAP keys (snake_case), NOT sheet header names
  //   - the appender reads `body[key]` directly, no `fields:` wrapper
  // Earlier version sent `{mode: "append", fields: {"Submission ID": ...}}`,
  // which returned `{ok: false, error: 'unauthorized'}` (no token) — Apps
  // Script still reports "Completed" for that response, so it silently
  // didn't write anything. Bug caught 2026-05-12 on the first Riverside
  // test submission.
  //
  // Employer-specific payload keys map to sheet headers via FIELD_MAP
  // entries added in v2 appender 2026-05-12 — those entries must be in
  // the deployed script revision, OR the cells stay blank. Headers that
  // aren't in FIELD_MAP (e.g. "Provider notes") render blank, which is
  // intended for Jane's free-text column.
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
  // Apps Script always returns 200 even for token failures and logic
  // errors — parse the body and surface non-ok responses as throws so
  // the fan-out logger picks them up.
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
  // Mirrors upsertLearnerInBrevo in _shared/route-lead.ts. Pushes the
  // employer as a Brevo contact with FIRSTNAME / LASTNAME (built-in
  // Brevo defaults) plus the B2B_* namespaced attributes from
  // switchable/site/docs/switchable-for-business/note-for-sasha.md §5.
  // B2B_ namespace keeps employer contacts non-colliding with B2C
  // SW_* learner contacts if the same email ever appears in both lists.
  //
  // Provider-level attributes (B2B_PROVIDER_NAME +
  // B2B_PROVIDER_TRUST_LINE) come from a SELECT against crm.providers
  // keyed by row.primary_routed_to. For v1 that's always
  // 'riverside-training' on the routed path. For DQ leads (no
  // primary_routed_to), both attributes ship as empty strings so the
  // U1 template renders cleanly even if it's ever fired against a
  // DQ branch.
  //
  // Best-effort: failure of either the provider lookup or the upsert
  // logs to console but does not throw, so the downstream U1
  // transactional send still fires (FIRSTNAME / COMPANY / etc. travel
  // inline as transactional params). Dead-letter is owned by the
  // leg-surfacing path in the main handler.
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
  // Mirrors the funded learner-ack pattern in netlify-lead-router:
  // sendTransactional → Brevo template (Wren-editable) → email_log
  // gets a row for analytics + idempotency. Brand 'switchable' because
  // it's a Switchable-for-Business submitter-facing email.
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
  // Mirrors the funded-provider notification pattern in
  // _shared/route-lead.ts: inline HTML via sendBrevoEmail, contact_email +
  // contact_name + cc_emails read from crm.providers, portal deep-link
  // when portal_enabled. The U2 stays PII-free in line with
  // feedback_provider_email_no_pii.md — only the lead reference + a link.
  //
  // TEST_MODE override (added 2026-05-12 after the Jane-got-3-test-emails
  // incident): when TEST_MODE='true' AND OWNER_TEST_EMAIL is set, the U2
  // recipient is forcibly redirected to OWNER_TEST_EMAIL and cc_emails are
  // stripped. The function still reads crm.providers to keep contact_name /
  // portal_enabled / sheet_id wiring honest in the email body. Set this env
  // pair before any test session that might trigger a real submission;
  // unset (or set to anything other than 'true') for production.
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
  // Always surface sheet as fallback when present. Portal is primary CTA
  // for portal-enabled providers; sheet sits below as a backup if the
  // portal misbehaves. For pre-portal providers, sheet is the only link.
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
// Plumbing helpers
// ---------------------------------------------------------------------------

async function persistDeadLetter(payload: JsonValue, reason: string): Promise<Response> {
  try {
    await sql.begin(async (tx: postgres.TransactionSql) => {
      await tx`SET LOCAL ROLE functions_writer`;
      await tx`
        INSERT INTO leads.dead_letter (source, error_context, raw_payload)
        VALUES ('edge_function_employer_lead_router', ${reason}, ${tx.json(payload)})
      `;
    });
  } catch (err) {
    console.error("dead_letter INSERT failed:", describeError(err));
  }
  return json({ status: "dead_letter", reason }, 200);
}

function firstTopLevelString(body: Record<string, JsonValue>, ...keys: string[]): string | null {
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

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
