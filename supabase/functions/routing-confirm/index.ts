// Edge Function: routing-confirm
//
// One-click handler for the confirm links embedded in the owner notification
// email. Owner clicks the link, this function:
//   1. Verifies the HMAC-signed token in the query string
//   2. Drops to functions_writer role
//   3. Checks idempotency (already-routed leads return a friendly "already
//      confirmed" page, not an error)
//   4. Inserts a row in leads.routing_log and updates leads.submissions
//      (primary_routed_to + routed_at) in one transaction
//   5. POSTs the lead row to the provider's Apps Script webhook
//   6. On success: sends a PII-free notification email to the provider
//   7. On sheet-append failure: sends a "paste manually" email to the owner
//      and logs a leads.dead_letter row; routing is still recorded (the DB is
//      the source of truth)
//   8. Returns a branded HTML confirmation page to the owner
//
// Secrets expected in env:
//   SUPABASE_DB_URL               (auto-injected)
//   ROUTING_CONFIRM_SHARED_SECRET (HMAC key for confirm-link tokens)
//   SHEETS_APPEND_TOKEN           (shared with the Apps Script on each sheet)
//   BREVO_API_KEY                 (transactional email)
//   BREVO_SENDER_EMAIL            (From address - e.g. charlotte@switchleads.co.uk)
//
// Architectural context:
//   - Owner-gated routing rule: owner clicks confirm, the function acts on
//     behalf of that click. No auto-routing.
//   - Sheets are transitional (retire with the Phase 4 provider dashboard).
//     See platform/docs/session-3-scope.md.

import postgres from "npm:postgres@3";
import { verifyRoutingToken } from "../_shared/routing-token.ts";
import { sendBrevoEmail } from "../_shared/brevo.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error(
    "SUPABASE_DB_URL is not set. Auto-injected by Supabase; check Edge Functions → Manage secrets if missing.",
  );
}

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

interface ProviderRow {
  provider_id: string;
  company_name: string;
  contact_email: string;
  contact_name: string | null;
  sheet_id: string | null;
  sheet_webhook_url: string | null;
  cc_emails: string[];
}

interface SubmissionRow {
  id: number;
  submitted_at: string;
  course_id: string | null;
  funding_category: string | null;
  funding_route: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;

  // Funded-shape
  la: string | null;
  region_scheme: string | null;
  age_band: string | null;
  employment_status: string | null;
  prior_level_3_or_higher: boolean | null;
  can_start_on_intake_date: boolean | null;
  outcome_interest: string | null;
  why_this_course: string | null;

  // Self-funded-shape (Session 5)
  postcode: string | null;
  region: string | null;
  reason: string | null;
  interest: string | null;
  situation: string | null;
  qualification: string | null;
  start_when: string | null;
  budget: string | null;
  courses_selected: string[] | null;

  is_dq: boolean;
  primary_routed_to: string | null;
  archived_at: string | null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "GET") {
    return htmlError("Method not allowed", 405);
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("t");
  if (!token) {
    return htmlError("Missing confirm token. This link may be malformed.", 400);
  }

  const secret = Deno.env.get("ROUTING_CONFIRM_SHARED_SECRET");
  if (!secret) {
    console.error("ROUTING_CONFIRM_SHARED_SECRET not set");
    return htmlError("Server misconfigured - secret missing. Flagging to owner.", 500);
  }

  const verify = await verifyRoutingToken(token, secret);
  if (!verify.ok) {
    const reason = verify.error === "expired"
      ? "This confirm link has expired. Expire window is 14 days from the lead landing."
      : "This confirm link is invalid. It may have been tampered with, or the signing secret has been rotated.";
    return htmlError(reason, 400);
  }

  const { submission_id, provider_id } = verify.payload!;

  let provider: ProviderRow;
  let submission: SubmissionRow;
  let courseTitle: string;
  let alreadyRouted = false;

  try {
    // Read phase (no writes, no role switch needed yet)
    const [providerRow] = await sql<ProviderRow[]>`
      SELECT provider_id, company_name, contact_email, contact_name,
             sheet_id, sheet_webhook_url, cc_emails
        FROM crm.providers
       WHERE provider_id = ${provider_id}
         AND archived_at IS NULL
         AND active = true
    `;
    if (!providerRow) {
      return htmlError(`Provider '${provider_id}' not found or inactive.`, 404);
    }
    provider = providerRow;

    const [submissionRow] = await sql<SubmissionRow[]>`
      SELECT id, submitted_at, course_id, funding_category, funding_route,
             first_name, last_name, email, phone,
             la, region_scheme, age_band, employment_status,
             prior_level_3_or_higher, can_start_on_intake_date,
             outcome_interest, why_this_course,
             postcode, region, reason, interest, situation,
             qualification, start_when, budget, courses_selected,
             is_dq, primary_routed_to, archived_at
        FROM leads.submissions
       WHERE id = ${submission_id}
    `;
    if (!submissionRow) {
      return htmlError(`Submission ${submission_id} not found.`, 404);
    }
    submission = submissionRow;

    if (submission.is_dq) {
      return htmlError(
        `Lead ${formatLeadId(submission.id, submission.submitted_at)} is marked DQ - it should not have a confirm link. Flag to platform as a bug.`,
        400,
      );
    }

    // Refuse to route an archived row. Archived = owner-test, dummy-test, or
    // deliberately-removed lead. Routing one would re-pollute provider sheets
    // with rows that the dashboard filter excludes from active counts. Defends
    // against a stale confirm link being clicked after a row was archived
    // post-routing (the bug behind the EMS 41-vs-43 mismatch on 2026-04-25).
    if (submission.archived_at) {
      return htmlError(
        `Lead ${formatLeadId(submission.id, submission.submitted_at)} is archived (${submission.archived_at}) and cannot be routed. If this is wrong, clear archived_at on the submission first.`,
        400,
      );
    }

    if (submission.primary_routed_to) {
      // Idempotency: already routed. Friendly page, no side effects.
      alreadyRouted = true;
      courseTitle = submission.course_id ?? "-";
      if (submission.primary_routed_to === provider_id) {
        return htmlConfirmation({
          title: "Already confirmed",
          headline: `This lead was already routed to ${provider.company_name}.`,
          body: `Lead ${formatLeadId(submission.id, submission.submitted_at)} - ${submission.first_name ?? ""} ${submission.last_name ?? ""}. No further action needed.`,
        });
      } else {
        return htmlError(
          `Lead ${formatLeadId(submission.id, submission.submitted_at)} was already routed to a different provider (${submission.primary_routed_to}). To re-route, update the row manually in SQL.`,
          409,
        );
      }
    }

    courseTitle = submission.course_id ?? "-";
  } catch (err) {
    console.error("read phase failed:", err);
    return htmlError(`Database read failed: ${describeError(err)}`, 500);
  }

  // Write phase - routing_log INSERT + submissions UPDATE in one transaction
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        INSERT INTO leads.routing_log (
          submission_id, provider_id, route_reason, delivery_method, delivery_status
        ) VALUES (
          ${submission.id}, ${provider.provider_id}, 'primary', 'sheet_webhook', 'sent'
        )
      `;
      await trx`
        UPDATE leads.submissions
           SET primary_routed_to = ${provider.provider_id},
               routed_at         = now(),
               updated_at        = now()
         WHERE id = ${submission.id}
      `;
    });
  } catch (err) {
    console.error("routing write failed:", err);
    return htmlError(`Routing write failed: ${describeError(err)}`, 500);
  }

  // Sheet append (best-effort; failure doesn't unwind routing)
  const sheetResult = await appendToProviderSheet(provider, submission, courseTitle);

  if (!sheetResult.ok) {
    // Log to dead letter so Sasha's weekly scan catches it
    await persistSheetFailure(provider.provider_id, submission.id, sheetResult.error ?? "unknown");
    // Email the owner: "paste manually"
    await sendOwnerSheetFailureEmail(provider, submission, courseTitle, sheetResult.error ?? "unknown");
    return htmlConfirmation({
      title: "Routed, but sheet append failed",
      headline: `Routing recorded for ${provider.company_name}, but the sheet didn't update.`,
      body: `Lead ${formatLeadId(submission.id, submission.submitted_at)} is in the DB. You've been emailed a copy to paste into ${provider.company_name}'s sheet. Provider has NOT been emailed yet - paste first, then message them manually this once.`,
    });
  }

  // Sheet append OK - notify the provider (PII-free)
  const providerEmailResult = await sendProviderNotification(provider, submission);
  if (!providerEmailResult.ok) {
    console.error("provider notification email failed:", providerEmailResult.error);
    // Non-fatal for routing (row is in the sheet, state committed). But Sasha's
    // weekly scan reads leads.dead_letter; a silent console.error leaves her
    // blind to a failing provider-email pattern. Write a dead_letter row so
    // recurring failures surface in her Monday scan. Matches the rationale in
    // changelog.md 2026-04-20 late-morning entry (EMS contact_email placeholder
    // incident) - we want provider-email failures to be visible even though
    // routing is recorded.
    await persistProviderEmailFailure(
      provider.provider_id,
      submission.id,
      providerEmailResult.error ?? "unknown",
    );
    return htmlConfirmation({
      title: "Routed, sheet updated, email to provider failed",
      headline: `Lead is in ${provider.company_name}'s sheet.`,
      body: `But we couldn't send the notification email to ${provider.contact_email}. Message them manually: "New enquiry in your sheet." A dead_letter row has been written so Sasha's Monday scan will flag if this pattern repeats. Flag to platform if it does.`,
    });
  }

  return htmlConfirmation({
    title: "Routed",
    headline: `Lead sent to ${provider.company_name}.`,
    body: `Lead ${formatLeadId(submission.id, submission.submitted_at)} is in ${provider.company_name}'s sheet with status 'open'. ${provider.contact_name ?? provider.company_name} has been notified.`,
  });
});

// ----- sheet append -----

async function appendToProviderSheet(
  provider: ProviderRow,
  submission: SubmissionRow,
  courseTitle: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!provider.sheet_webhook_url) {
    return { ok: false, error: "provider has no sheet_webhook_url configured" };
  }
  const token = Deno.env.get("SHEETS_APPEND_TOKEN");
  if (!token) {
    return { ok: false, error: "SHEETS_APPEND_TOKEN not set" };
  }

  // Session 5: send a FULL-FAT payload. Every field routing-confirm can
  // meaningfully pass, regardless of which form shape produced the lead.
  // Apps Script v2 on the receiving sheet reads the sheet's header row and
  // maps each header to a payload key via its FIELD_MAP - if the header
  // isn't in the map, the cell stays empty; if the payload doesn't carry
  // the field the header asked for, same. One script, any sheet shape.
  //
  // Pre-Session-5 Apps Script v1 only read a fixed set of keys
  // (lead_id, submitted_at, course, name, email, phone, la, region_scheme,
  //  age_band, employment, prior_l3, start_date_checked, provider, status,
  //  enrolment_date, charge, notes). v1 is forward-compatible with v2's
  // payload - extra keys are simply ignored by v1's positional appendRow.
  // v2-deployed sheets pick up the new fields via their headers.
  //
  // Values are lowercased per owner preference (2026-04-20), same as before,
  // except `status` (literal "Open") and `provider` (slug, already lower).
  const lc = (v: string | null | undefined) => (v ?? "").toLowerCase();
  const coursesSelectedCsv = (submission.courses_selected ?? []).join(", ");
  const row = {
    token,

    // Identity / metadata
    lead_id: lc(formatLeadId(submission.id, submission.submitted_at)),
    submission_id: submission.id,
    submitted_at: lc(formatUkTimestamp(submission.submitted_at)),
    course: lc(courseTitle),
    course_id: lc(submission.course_id),
    funding_category: lc(submission.funding_category),
    funding_route: lc(submission.funding_route),
    provider: provider.provider_id,
    status: "Open",

    // Learner PII
    name: lc([submission.first_name, submission.last_name].filter(Boolean).join(" ")),
    first_name: lc(submission.first_name),
    last_name: lc(submission.last_name),
    email: lc(submission.email),
    phone: lc(submission.phone),

    // Funded-shape learner fields
    la: lc(submission.la),
    region_scheme: lc(submission.region_scheme),
    age_band: lc(submission.age_band),
    employment: lc(submission.employment_status),
    prior_l3: lc(boolToYesNo(submission.prior_level_3_or_higher)),
    start_date_checked: lc(boolToYesNo(submission.can_start_on_intake_date)),
    outcome_interest: lc(submission.outcome_interest),
    why_this_course: lc(submission.why_this_course),

    // Self-funded-shape learner fields (Session 5)
    postcode: lc(submission.postcode),
    region: lc(submission.region),
    reason: lc(submission.reason),
    interest: lc(submission.interest),
    situation: lc(submission.situation),
    qualification: lc(submission.qualification),
    start_when: lc(submission.start_when),
    budget: lc(submission.budget),
    courses_selected: lc(coursesSelectedCsv),
  };

  // Apps Script Web apps process the POST body on the initial call to /exec,
  // THEN return a 302 pointing at script.googleusercontent.com/macros/echo -
  // which serves the script's response body and only accepts GET. Default
  // fetch redirect handling (POST→GET conversion on 302) is exactly what
  // this flow expects. Don't handle redirects manually; doing so with POST
  // hits the echo URL with the wrong method and gets 405.
  let res: Response;
  try {
    res = await fetch(provider.sheet_webhook_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(row),
    });
  } catch (err) {
    return { ok: false, error: `fetch failed: ${String(err)}` };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "<body unreadable>");
    return { ok: false, error: `apps script ${res.status}: ${text.slice(0, 300)}` };
  }

  try {
    const body = await res.json() as { ok?: boolean; error?: string };
    if (body.ok === true) return { ok: true };
    return { ok: false, error: body.error ?? "apps script returned ok=false" };
  } catch {
    // Apps Script returned 2xx but not JSON; trust the status.
    return { ok: true };
  }
}

async function persistSheetFailure(providerId: string, submissionId: number, error: string): Promise<void> {
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        INSERT INTO leads.dead_letter (source, raw_payload, error_context)
        VALUES (
          'edge_function_sheet_append',
          ${sql.json({ provider_id: providerId, submission_id: submissionId })},
          ${`Sheet webhook append failed: ${error}`}
        )
      `;
    });
  } catch (err) {
    console.error("failed to write dead_letter row:", err);
  }
}

async function persistProviderEmailFailure(providerId: string, submissionId: number, error: string): Promise<void> {
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        INSERT INTO leads.dead_letter (source, raw_payload, error_context)
        VALUES (
          'edge_function_provider_email',
          ${sql.json({ provider_id: providerId, submission_id: submissionId })},
          ${`Provider notification email failed: ${error}`}
        )
      `;
    });
  } catch (err) {
    console.error("failed to write dead_letter row:", err);
  }
}

// ----- emails -----

async function sendProviderNotification(
  provider: ProviderRow,
  submission: SubmissionRow,
): Promise<{ ok: boolean; error?: string }> {
  const leadId = formatLeadId(submission.id, submission.submitted_at);
  const sheetLink = provider.sheet_id
    ? `https://docs.google.com/spreadsheets/d/${provider.sheet_id}/edit`
    : null;

  const html = `
    <p>Hi ${provider.contact_name ?? "there"},</p>
    <p>You have a new enquiry (${leadId}) in your SwitchLeads sheet.</p>
    ${sheetLink ? `<p><a href="${sheetLink}">Open your sheet</a></p>` : ""}
    <p>The lead has been added with status <strong>open</strong>. Please update the status and notes as you work through the follow-up.</p>
    <p>Thanks,<br>SwitchLeads</p>
  `.trim();

  // CC list:
  //   - owner (always) - full record of what providers have been told, no DB read needed
  //   - provider.cc_emails (Session 5) - per-provider co-recipients (e.g. Ranjit at Courses Direct)
  // Deduped case-insensitively so the owner email can't be doubled if someone seeds it
  // into a provider's cc_emails by mistake.
  const ownerEmail = Deno.env.get("OWNER_NOTIFICATION_EMAIL") ?? Deno.env.get("BREVO_SENDER_EMAIL");
  const ccList = buildCcList(ownerEmail, provider.cc_emails);

  return await sendBrevoEmail({
    to: [{ email: provider.contact_email, name: provider.contact_name ?? provider.company_name }],
    cc: ccList.length > 0 ? ccList : undefined,
    subject: `New enquiry - ${leadId}`,
    htmlContent: html,
    tags: ["routing-confirm", "provider-notification"],
  });
}

// Build the deduped CC list for provider notifications. Owner (if configured)
// is always first; provider's cc_emails follow. Case-insensitive dedup against
// the `to` address and against earlier entries in the list. Returns [] if no
// CCs are needed - callers should pass `undefined` to sendBrevoEmail in that
// case (Brevo treats [] and undefined differently in some edge cases).
function buildCcList(
  ownerEmail: string | undefined,
  providerCcEmails: string[] | null,
): Array<{ email: string; name?: string }> {
  const seen = new Set<string>();
  const result: Array<{ email: string; name?: string }> = [];
  const add = (email: string | null | undefined, name?: string) => {
    if (!email) return;
    const key = email.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(name ? { email, name } : { email });
  };
  add(ownerEmail, "Charlotte");
  for (const cc of providerCcEmails ?? []) add(cc);
  return result;
}

async function sendOwnerSheetFailureEmail(
  provider: ProviderRow,
  submission: SubmissionRow,
  courseTitle: string,
  error: string,
): Promise<void> {
  const leadId = formatLeadId(submission.id, submission.submitted_at);
  const name = [submission.first_name, submission.last_name].filter(Boolean).join(" ") || "(no name)";

  // Render as a key-value table rather than a tab-separated row. Pre-Session-5
  // this was a TSV row sized for the EMS header layout - now that different
  // providers have different sheet shapes, a generic dump is more useful.
  // Owner picks whichever rows their sheet needs.
  const fields: Array<[string, string | null]> = [
    ["Lead ID", leadId],
    ["Submitted at", formatUkTimestamp(submission.submitted_at)],
    ["Course", courseTitle],
    ["Name", name === "(no name)" ? null : name],
    ["Email", submission.email],
    ["Phone", submission.phone],
    ["Local authority", submission.la],
    ["Region scheme", submission.region_scheme],
    ["Age band", submission.age_band],
    ["Employment", submission.employment_status],
    ["Prior L3", boolToYesNo(submission.prior_level_3_or_higher) || null],
    ["Can start on intake", boolToYesNo(submission.can_start_on_intake_date) || null],
    ["Outcome interest", submission.outcome_interest],
    ["Why this course", submission.why_this_course],
    ["Postcode", submission.postcode],
    ["Region", submission.region],
    ["Reason", submission.reason],
    ["Interest", submission.interest],
    ["Situation", submission.situation],
    ["Qualification seeking", submission.qualification],
    ["Start when", submission.start_when],
    ["Budget", submission.budget],
    ["Courses selected", (submission.courses_selected ?? []).join(", ") || null],
    ["Provider", provider.company_name],
    ["Status", "open"],
  ];
  const fieldRows = fields
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#666;vertical-align:top;">${escapeHtml(k)}</td><td style="padding:2px 0;">${escapeHtml(v as string)}</td></tr>`)
    .join("");

  const html = `
    <p>Routing recorded for ${escapeHtml(provider.company_name)}, but the Apps Script append failed.</p>
    <p><strong>Error:</strong> ${escapeHtml(error)}</p>
    <p><strong>Lead details - paste into ${escapeHtml(provider.company_name)}'s sheet manually:</strong></p>
    <table style="border-collapse:collapse;font-size:14px;">${fieldRows}</table>
    <p>Provider has NOT been emailed - notify ${escapeHtml(provider.contact_email)} manually this once.</p>
    <p>A leads.dead_letter row has been written (source=edge_function_sheet_append) so Sasha's weekly scan will flag if this pattern repeats.</p>
  `.trim();

  const ownerEmail = Deno.env.get("OWNER_NOTIFICATION_EMAIL") ?? Deno.env.get("BREVO_SENDER_EMAIL");
  if (!ownerEmail) {
    console.error("No owner email address configured for sheet failure notification");
    return;
  }

  await sendBrevoEmail({
    to: [{ email: ownerEmail, name: "Charlotte" }],
    subject: `Sheet append failed - ${leadId} - ${provider.company_name}`,
    htmlContent: html,
    tags: ["routing-confirm", "owner-fallback"],
  });
}

// ----- HTML pages -----

interface ConfirmationPage {
  title: string;
  headline: string;
  body: string;
}

function htmlConfirmation(page: ConfirmationPage): Response {
  const html = renderPage(page.title, page.headline, page.body);
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function htmlError(message: string, status: number): Response {
  const html = renderPage("Error", "Something's not right", escapeHtml(message));
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function renderPage(title: string, headline: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - SwitchLeads</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 560px; margin: 64px auto; padding: 0 24px; color: #111; line-height: 1.5; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  p { margin: 0 0 12px; }
  .meta { color: #666; font-size: 14px; margin-top: 32px; }
  pre { background: #f5f5f5; padding: 12px; overflow-x: auto; font-size: 13px; }
  a { color: #0a6cff; }
</style>
</head>
<body>
<h1>${escapeHtml(headline)}</h1>
<p>${body}</p>
<p class="meta">SwitchLeads · routing-confirm</p>
</body>
</html>`;
}

// ----- formatting helpers -----

function formatLeadId(id: number, submittedAt: string): string {
  // Matches the SL-YY-MM-NNNN pattern used elsewhere (see platform/docs/changelog.md).
  const d = new Date(submittedAt);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const nnnn = String(id).padStart(4, "0");
  return `SL-${yy}-${mm}-${nnnn}`;
}

function formatUkTimestamp(iso: string): string {
  // Keep simple - UK local-ish readable format. The sheet owner just needs to know
  // when the lead arrived; sub-second precision isn't useful.
  const d = new Date(iso);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

function boolToYesNo(v: boolean | null): string {
  if (v === true) return "Yes";
  if (v === false) return "No";
  return "";
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
  if (err instanceof Error) {
    const pgErr = err as Error & { code?: string; detail?: string };
    const parts: string[] = [];
    if (pgErr.code) parts.push(`code=${pgErr.code}`);
    if (err.message) parts.push(err.message);
    if (pgErr.detail) parts.push(pgErr.detail);
    return parts.join(" | ");
  }
  try { return JSON.stringify(err); } catch { return String(err); }
}
