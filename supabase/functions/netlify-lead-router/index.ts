// Edge Function: netlify-lead-router
// Receives a Netlify Forms outgoing webhook, normalises the payload into the
// canonical leads.submissions shape, and INSERTs the row. Failures go to
// leads.dead_letter so no submission is ever lost at the capture boundary.
//
// Owner-gated routing rule (standing): this function does NOT contact the
// provider. It persists the lead and emails the owner with a signed confirm
// button per candidate provider. Provider delivery happens in routing-confirm
// after the owner clicks. Per memory/feedback_owner_routes_leads.md.
//
// Session 3.3 (2026-04-21) rearchitecture: the router now responds 200 to
// Netlify as soon as the DB insert commits. The owner notification email runs
// as a post-response background task via EdgeRuntime.waitUntil so a slow
// Brevo call can never cause Netlify's webhook to time out and auto-disable
// itself. Normalisation and insertion logic moved to _shared/ingest.ts so
// netlify-leads-reconcile can write the same rows via the same code path.
//
// Role: connects via Supabase's auto-injected SUPABASE_DB_URL (postgres
// superuser) and drops to the scoped `functions_writer` role at the start of
// every transaction via SET LOCAL ROLE inside the shared insert helper.

import postgres from "npm:postgres@3";
import { signRoutingToken } from "../_shared/routing-token.ts";
import { sendBrevoEmail } from "../_shared/brevo.ts";
import {
  type CanonicalSubmission,
  insertSubmission,
  type JsonValue,
  normaliseAndOverride,
} from "../_shared/ingest.ts";
import { routeLead, upsertLearnerInBrevoNoMatch } from "../_shared/route-lead.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error(
    "SUPABASE_DB_URL is not set. This should be auto-injected by Supabase for every Edge Function.",
  );
}

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false, // Supabase transaction pooler does not support prepared statements.
});

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

  // Netlify outgoing webhook payload shape:
  //   - Top level: Netlify metadata (id, form_name, form_id, site_url, created_at,
  //     and convenience copies of email/first_name/last_name)
  //   - body.data: the actual submitted form fields (all our hidden inputs and
  //     user-entered values live here - course_id, provider_ids, phone, etc.)
  const body = rawBody as Record<string, JsonValue> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return await persistDeadLetter(rawBody, "Request body is not an object");
  }

  const formName = firstTopLevelString(body, "form_name", "form-name");
  if (!formName) {
    return await persistDeadLetter(rawBody, "Missing form_name / form-name");
  }

  // `contact` is in the site's form allowlist as a no-routing form - it's a
  // general-enquiry modal, not a lead capture. The Netlify webhook fires
  // site-wide ("Any form"), so the function receives contact submissions too.
  // Return 200 without inserting to keep leads.submissions tidy. Netlify's
  // existing email notification continues to deliver the enquiry to the owner.
  if (formName === "contact") {
    return json({ status: "ignored", form_name: formName, reason: "contact form not persisted" });
  }

  const row = normaliseAndOverride(formName, body, rawBody);

  let result;
  try {
    result = await insertSubmission(sql, row);
  } catch (err) {
    console.error("leads.submissions INSERT failed. err:", err);
    return await persistDeadLetter(rawBody, `leads.submissions INSERT failed: ${describeError(err)}`);
  }

  // Duplicate: Netlify re-delivered the same submission (webhook retry, or
  // reconcile already back-filled it). Return 200 with the existing id so
  // Netlify stops retrying. No email - the original insert path already sent
  // one (or intentionally didn't, if the row is DQ).
  if (result.duplicate) {
    return json({ status: "duplicate", submission_id: result.id, form_name: formName });
  }

  // Referral programme (migration 0053). If the form payload carries a ref code
  // (site captures ?ref=CODE from URL into a hidden input), look up the
  // referrer, run anti-fraud, and either insert a leads.referrals row in
  // 'pending' status (linking the new lead to the referrer) or mark
  // 'fraud_rejected' with a fraud_reason. Runs as a waitUntil background task
  // so it cannot delay the 200 response back to Netlify (Session 3.3 pattern).
  const refCode = extractRefCode(body);
  if (refCode) {
    const refRuntime = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
    const refTask = processReferral(result.id, refCode, row).catch((err) =>
      console.error("referral processing failed:", describeError(err)),
    );
    if (refRuntime?.waitUntil) {
      refRuntime.waitUntil(refTask);
    }
    // If runtime is not available (local test), let it run inline.
  }

  // Routing decision: auto-route vs email-confirm.
  //
  // Auto-route v1 (per platform/docs/auto-routing-design.md):
  //   - Lead is qualified (is_dq = false)
  //   - Exactly one candidate provider on the form payload
  //   - That provider is active, not archived, and has auto_route_enabled = true
  // → call routeLead() in 'auto_route' mode (does the same DB + sheet + provider
  //   email work as routing-confirm), then send an FYI email to the owner.
  //
  // Otherwise (DQ, no candidate, multiple candidates, or single candidate with
  // auto_route_enabled = false) → existing email-confirm flow: owner gets
  // confirm buttons and clicks one to trigger routing-confirm.
  //
  // Both paths run as post-response background tasks via EdgeRuntime.waitUntil
  // so a slow Brevo or sheet append can never time out Netlify's webhook
  // (Session 3.3 incident, 2026-04-21).
  //
  // Brevo 3-state push (no_match / pending / matched) — added 2026-04-30 per
  // platform/docs/no-match-brevo-build.md:
  //   - DQ or 0 candidates → upsertLearnerInBrevoNoMatch(..., "no_match")
  //   - matched leads (auto-route or owner-confirm) push from inside routeLead
  //     via upsertLearnerInBrevo with SW_MATCH_STATUS=matched
  //   - 2+ candidates OR 1 candidate that won't auto-route → push "pending"
  //     here, owner-confirm flips it to "matched" later
  // The no_match push runs whether or not the routable branch fires, so the
  // call site for no_match sits OUTSIDE the !is_dq && provider_ids.length > 0
  // guard. The pending push lives inside the guard alongside the existing
  // owner-confirm flow.
  const runtime0 = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;

  if (row.is_dq || row.provider_ids.length === 0) {
    const noMatchTask = upsertLearnerInBrevoNoMatch(sql, result.id, "no_match")
      .catch((err) => console.error("Brevo no_match upsert failed:", describeError(err)));
    if (runtime0?.waitUntil) runtime0.waitUntil(noMatchTask);
  }

  if (!row.is_dq && row.provider_ids.length > 0) {
    const isSingleCandidate = row.provider_ids.length === 1;
    const candidateProviderId: string | null = isSingleCandidate ? row.provider_ids[0] : null;

    // Re-application detection (lead dedup v1, migration 0026).
    // Parent was found by ingest AND candidate provider matches parent's
    // existing primary_routed_to → this is a same-provider re-application.
    // Skip auto-routing the new row, send the provider a "they reapplied"
    // notification, and FYI the owner.
    const isSameProviderReApplication =
      result.parentSubmissionId !== null &&
      result.parentPrimaryRoutedTo !== null &&
      candidateProviderId !== null &&
      result.parentPrimaryRoutedTo === candidateProviderId;

    let autoRouteEligible = false;

    if (isSingleCandidate && !isSameProviderReApplication) {
      try {
        const [eligibility] = await sql<Array<{ auto_route_enabled: boolean; active: boolean; archived_at: string | null }>>`
          SELECT auto_route_enabled, active, archived_at
            FROM crm.providers
           WHERE provider_id = ${candidateProviderId}
        `;
        autoRouteEligible = Boolean(
          eligibility &&
            eligibility.auto_route_enabled &&
            eligibility.active &&
            !eligibility.archived_at,
        );
      } catch (err) {
        console.error("auto-route eligibility check failed:", describeError(err));
      }
    }

    const runtime = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;

    if (isSameProviderReApplication && candidateProviderId) {
      // Re-application path: skip routing, notify provider + owner.
      const reApplicationTask = handleReApplication(
        result.id,
        result.parentSubmissionId!,
        candidateProviderId,
        row,
      ).catch((err) => console.error("re-application handler failed:", describeError(err)));
      if (runtime?.waitUntil) runtime.waitUntil(reApplicationTask);
    } else if (autoRouteEligible && candidateProviderId) {
      const autoRouteTask = (async () => {
        const outcome = await routeLead(sql, result.id, candidateProviderId, "auto_route");
        if (outcome.kind !== "ok") {
          console.error("auto-route failed:", JSON.stringify(outcome));
          // Fall back to confirm email so the lead doesn't get lost.
          await notifyOwnerOfRoutableLead(result.id, row).catch((err) =>
            console.error("fallback owner notification failed:", describeError(err)),
          );
          return;
        }
        await sendOwnerAutoRouteFyiEmail(result.id, row, outcome.providerCompany, outcome.providerId, outcome.sheetAppended, outcome.providerNotified);
      })().catch((err) => console.error("auto-route task failed:", describeError(err)));

      if (runtime?.waitUntil) runtime.waitUntil(autoRouteTask);
    } else {
      // Email-confirm flow: candidates exist but auto-route isn't firing
      // (multiple candidates, or single candidate without auto_route_enabled).
      // Push "pending" to Brevo so the SF13 "we're picking your provider"
      // sequence fires; owner clicking confirm later flips the contact to
      // "matched" via routeLead's upsertLearnerInBrevo.
      const pendingTask = upsertLearnerInBrevoNoMatch(sql, result.id, "pending")
        .catch((err) => console.error("Brevo pending upsert failed:", describeError(err)));
      if (runtime?.waitUntil) runtime.waitUntil(pendingTask);

      const emailTask = notifyOwnerOfRoutableLead(result.id, row).catch((notifyErr) => {
        console.error("owner notification failed:", describeError(notifyErr));
      });
      if (runtime?.waitUntil) runtime.waitUntil(emailTask);
    }
  }

  return json({ status: "ok", submission_id: result.id, form_name: formName });
});

// ----- Owner FYI email (auto-route path) -----

async function sendOwnerAutoRouteFyiEmail(
  submissionId: number,
  row: CanonicalSubmission,
  providerCompany: string,
  providerId: string,
  sheetAppended: boolean,
  providerNotified: boolean,
): Promise<void> {
  const ownerEmail = Deno.env.get("OWNER_NOTIFICATION_EMAIL") ?? Deno.env.get("BREVO_SENDER_EMAIL");
  if (!ownerEmail) {
    console.error("No owner email address configured for auto-route FYI");
    return;
  }

  const leadId = formatLeadId(submissionId, row.submitted_at);
  const fullName = [row.first_name, row.last_name].filter(Boolean).join(" ") || "(no name)";
  const dashboardUrl = `https://admin.switchleads.co.uk/leads/${submissionId}`;

  const sideEffectsLine = sheetAppended && providerNotified
    ? "Sheet appended, provider notified."
    : !sheetAppended
      ? "<strong>Sheet append failed</strong> — check the dead_letter row, paste manually."
      : "Sheet appended, but <strong>provider notification email failed</strong> — message them manually.";

  const html = `
    <p>Auto-routed lead ${leadId} (${fullName}, ${row.email ?? "no email"}) to <strong>${providerCompany}</strong>.</p>
    <p>${sideEffectsLine}</p>
    <p><a href="${dashboardUrl}">Open lead in dashboard</a></p>
    <p style="color:#666;font-size:12px;margin-top:24px;">This is an FYI — no action needed unless side effects flagged above. Auto-routing fires when there's exactly one candidate provider and that provider has auto_route_enabled = true. To turn it off for ${providerId}, edit the provider in the dashboard.</p>
  `.trim();

  await sendBrevoEmail({
    to: [{ email: ownerEmail, name: "Charlotte" }],
    subject: `Auto-routed: ${leadId} → ${providerCompany}`,
    htmlContent: html,
    tags: ["lead-router", "auto-route-fyi"],
  });
}

// ----- Re-application handler -----
//
// Called when ingest detects a same-provider re-application (parent's
// primary_routed_to == new candidate provider). Skips routing, notifies the
// provider that this lead has reapplied, FYIs the owner, writes a system
// audit row marking re-engagement.
//
// The provider's sheet is NOT appended in V1 (that ships in V2 once each
// provider's Apps Script supports the reapply op). For now the provider
// gets an email so they can re-engage with the original sheet entry.

async function handleReApplication(
  submissionId: number,
  parentSubmissionId: number,
  providerId: string,
  row: CanonicalSubmission,
): Promise<void> {
  // Look up the parent so we can label the marker row + emails with its lead_id.
  const [parent] = await sql<Array<{ id: number; submitted_at: string; first_name: string | null; last_name: string | null; re_submission_count: number }>>`
    SELECT id, submitted_at, first_name, last_name, re_submission_count
      FROM leads.submissions
     WHERE id = ${parentSubmissionId}
  `;
  if (!parent) {
    console.error("re-application: parent submission not found:", parentSubmissionId);
    return;
  }

  const parentLeadId = formatLeadId(parent.id, parent.submitted_at);
  const newLeadId = formatLeadId(submissionId, row.submitted_at);

  // Route the new submission via the shared routeLead helper in re_application
  // mode. This writes the routing_log row, sets primary_routed_to, appends a
  // marker row to the provider's sheet (status='Re-applied', notes points to
  // parent_lead_id), sends the PII-free re-applied provider notification, and
  // writes the system audit row.
  const outcome = await routeLead(sql, submissionId, providerId, "re_application", {
    parentSubmissionId,
    parentLeadId,
    parentSubmittedAt: parent.submitted_at,
  });

  if (outcome.kind !== "ok") {
    console.error("re-application routeLead failed:", JSON.stringify(outcome));
    return;
  }

  // Owner FYI (separate from the provider-facing email — this one carries PII
  // because it's an internal notification to Charlotte).
  const ownerEmail = Deno.env.get("OWNER_NOTIFICATION_EMAIL") ?? Deno.env.get("BREVO_SENDER_EMAIL");
  if (!ownerEmail) return;

  const fullName = [row.first_name, row.last_name].filter(Boolean).join(" ") ||
    [parent.first_name, parent.last_name].filter(Boolean).join(" ") ||
    "(no name)";
  const dashboardUrl = `https://admin.switchleads.co.uk/leads/${submissionId}`;
  const sideEffects = outcome.sheetAppended && outcome.providerNotified
    ? "Re-applied marker row added to sheet, provider notified."
    : !outcome.sheetAppended
      ? "<strong>Sheet append failed</strong> — check the dead_letter row."
      : "Marker row added, but <strong>provider notification email failed</strong>.";

  const ownerHtml = `
    <p>${escapeHtml(fullName)} has reapplied — ${newLeadId} is a re-application of ${parentLeadId} → ${escapeHtml(outcome.providerCompany)}.</p>
    <p>${sideEffects}</p>
    <p><a href="${dashboardUrl}">Open new lead in dashboard</a> · <a href="https://admin.switchleads.co.uk/leads/${parent.id}">Open original lead</a></p>
    <p style="color:#666;font-size:12px;margin-top:24px;">This is the ${parent.re_submission_count + 1}${ordinalSuffix(parent.re_submission_count + 1)} time this person has engaged. The marker row at the bottom of the provider's sheet has status="Re-applied" and points back to ${parentLeadId}.</p>
  `.trim();

  try {
    await sendBrevoEmail({
      to: [{ email: ownerEmail, name: "Charlotte" }],
      subject: `Re-applied: ${newLeadId} → ${outcome.providerCompany}`,
      htmlContent: ownerHtml,
      tags: ["lead-router", "re-application", "owner-fyi"],
    });
  } catch (err) {
    console.error("re-application owner FYI failed:", describeError(err));
  }
}

function ordinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

// ----- Owner notification email with confirm links -----
//
// Called after a non-DQ lead with at least one candidate provider lands in
// leads.submissions. Fetches each candidate provider's details, signs a
// confirm-link token per candidate, and sends a single email to the owner
// with the full lead context and a confirm button per provider.
//
// The confirm link points at the routing-confirm Edge Function. See that
// function for the rest of the flow (sheet append, provider notification).
//
// Errors in this function are logged but never surface to the caller (the
// router's response has already been sent by the time this runs).

interface NotificationProviderRow {
  provider_id: string;
  company_name: string;
}

async function notifyOwnerOfRoutableLead(
  submissionId: number,
  row: CanonicalSubmission,
): Promise<void> {
  const secret = Deno.env.get("ROUTING_CONFIRM_SHARED_SECRET");
  if (!secret) {
    console.error("ROUTING_CONFIRM_SHARED_SECRET not set; cannot sign confirm links");
    return;
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) {
    console.error("SUPABASE_URL not set; cannot build confirm link base URL");
    return;
  }
  const ownerEmail = Deno.env.get("OWNER_NOTIFICATION_EMAIL") ?? Deno.env.get("BREVO_SENDER_EMAIL");
  if (!ownerEmail) {
    console.error("No owner email configured (OWNER_NOTIFICATION_EMAIL or BREVO_SENDER_EMAIL)");
    return;
  }

  // Fetch candidate provider details. Only include active, non-archived.
  const providers = await sql<NotificationProviderRow[]>`
    SELECT provider_id, company_name
      FROM crm.providers
     WHERE provider_id = ANY(${row.provider_ids})
       AND active = true
       AND archived_at IS NULL
  `;
  const providerMap = new Map(providers.map((p) => [p.provider_id, p]));
  const missing = row.provider_ids.filter((id) => !providerMap.has(id));
  if (missing.length > 0) {
    console.warn(`provider_ids not found or inactive: ${missing.join(", ")} (submission ${submissionId})`);
  }
  if (providers.length === 0) {
    console.error(`submission ${submissionId} has no valid candidate providers; owner notification skipped`);
    return;
  }

  const confirmLinks: Array<{ provider: NotificationProviderRow; url: string }> = [];
  for (const p of providers) {
    const token = await signRoutingToken(submissionId, p.provider_id, secret);
    const url = `${supabaseUrl}/functions/v1/routing-confirm?t=${encodeURIComponent(token)}`;
    confirmLinks.push({ provider: p, url });
  }

  const leadId = formatLeadId(submissionId, row.submitted_at);
  const subject = `New lead ${leadId} - ${providers.map((p) => p.company_name).join(" / ")}`;
  const html = composeOwnerEmailHtml(leadId, submissionId, row, confirmLinks);

  const res = await sendBrevoEmail({
    to: [{ email: ownerEmail, name: "Charlotte" }],
    subject,
    htmlContent: html,
    tags: ["owner-notification", "lead-router"],
  });
  if (!res.ok) {
    console.error(`Brevo send failed for submission ${submissionId}: ${res.error}`);
  }
}

function composeOwnerEmailHtml(
  leadId: string,
  submissionId: number,
  row: CanonicalSubmission,
  confirmLinks: Array<{ provider: NotificationProviderRow; url: string }>,
): string {
  // Render both funded and self-funded learner fields. renderKeyValueList
  // drops null/empty rows, so a funded submission shows only the funded
  // cluster and a self-funded submission shows only the self-funded cluster.
  // Mixed forms (e.g. WYK's LIFT funded form with a postcode gate) show
  // both clusters naturally.
  const learnerFields: Array<[string, string | null]> = [
    ["Name", [row.first_name, row.last_name].filter(Boolean).join(" ") || null],
    ["Email", row.email],
    ["Phone", row.phone],
    // Funded-shape
    ["Local authority", row.la],
    ["Region scheme", row.region_scheme],
    ["Age band", row.age_band],
    ["Employment", row.employment_status],
    ["Prior L3+", boolToLabel(row.prior_level_3_or_higher)],
    ["Can start on intake date", boolToLabel(row.can_start_on_intake_date)],
    ["Outcome interest", row.outcome_interest],
    ["Why this course", row.why_this_course],
    // Self-funded-shape (Session 5)
    ["Postcode", row.postcode],
    ["Region", row.region],
    ["Reason", row.reason],
    ["Interest", row.interest],
    ["Situation", row.situation],
    ["Qualification seeking", row.qualification],
    ["Start when", row.start_when],
    ["Budget", row.budget],
    ["Courses selected", row.courses_selected.length > 0 ? row.courses_selected.join(", ") : null],
  ];
  const attributionFields: Array<[string, string | null]> = [
    ["UTM source", row.utm_source],
    ["UTM medium", row.utm_medium],
    ["UTM campaign", row.utm_campaign],
    ["UTM content", row.utm_content],
    ["Referrer", row.referrer],
    ["fbclid", row.fbclid ? "yes" : null],
    ["gclid", row.gclid ? "yes" : null],
  ];

  const buttons = confirmLinks
    .map((l) => `<a href="${escapeHtml(l.url)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;background:#0a6cff;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Confirm to ${escapeHtml(l.provider.company_name)}</a>`)
    .join("");

  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#111;line-height:1.5;">
<h2 style="margin:0 0 8px;font-size:20px;">New lead ${escapeHtml(leadId)}</h2>
<p style="color:#666;margin:0 0 24px;">Course: <strong>${escapeHtml(humaniseSlug(row.course_id))}</strong> &middot; Funding: <strong>${escapeHtml(row.funding_category ?? "-")}${row.funding_route ? ` / ${escapeHtml(row.funding_route)}` : ""}</strong></p>

<div style="margin:0 0 24px;">${buttons}</div>

<h3 style="font-size:15px;margin:24px 0 8px;color:#333;">Learner</h3>
${renderKeyValueList(learnerFields)}

<h3 style="font-size:15px;margin:24px 0 8px;color:#333;">Consent</h3>
${renderKeyValueList([
  ["Terms accepted", row.terms_accepted ? "yes" : "no"],
  ["Marketing opt-in", row.marketing_opt_in ? "yes" : "no"],
])}

<h3 style="font-size:15px;margin:24px 0 8px;color:#333;">Attribution</h3>
${renderKeyValueList(attributionFields)}

<p style="margin-top:32px;color:#888;font-size:13px;">
  Submission id: <code>${submissionId}</code> &middot; Confirm link valid for 14 days.<br>
  If none of the candidate providers are right, update <code>leads.submissions.primary_routed_to</code> via SQL.
</p>
</body></html>`;
}

function renderKeyValueList(pairs: Array<[string, string | null]>): string {
  const rows = pairs
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#666;vertical-align:top;">${escapeHtml(k)}</td><td style="padding:2px 0;">${escapeHtml(v as string)}</td></tr>`)
    .join("");
  return `<table style="border-collapse:collapse;font-size:14px;">${rows}</table>`;
}

function formatLeadId(id: number, submittedAt: string): string {
  // SL-YY-MM-NNNN. Matches the format used elsewhere (platform/docs/changelog.md).
  const d = new Date(submittedAt);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const nnnn = String(id).padStart(4, "0");
  return `SL-${yy}-${mm}-${nnnn}`;
}

function humaniseSlug(slug: string | null): string {
  if (!slug) return "-";
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function boolToLabel(v: boolean | null): string | null {
  if (v === true) return "yes";
  if (v === false) return "no";
  return null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function persistDeadLetter(
  rawPayload: JsonValue,
  errorContext: string,
): Promise<Response> {
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        INSERT INTO leads.dead_letter (source, raw_payload, error_context)
        VALUES ('netlify_forms', ${sql.json(rawPayload ?? {})}, ${errorContext})
      `;
    });
  } catch (deadLetterErr) {
    console.error("dead_letter write failed:", describeError(deadLetterErr), "original error:", errorContext);
  }
  return json({ status: "dead_letter", error: errorContext }, 200);
}

function describeError(err: unknown): string {
  if (!err) return "unknown error (falsy)";
  if (err instanceof Error) {
    const pgErr = err as Error & {
      code?: string;
      detail?: string;
      hint?: string;
      severity?: string;
      where?: string;
    };
    const parts: string[] = [];
    if (pgErr.code) parts.push(`code=${pgErr.code}`);
    if (pgErr.severity) parts.push(`severity=${pgErr.severity}`);
    if (err.message) parts.push(`message=${err.message}`);
    if (pgErr.detail) parts.push(`detail=${pgErr.detail}`);
    if (pgErr.hint) parts.push(`hint=${pgErr.hint}`);
    if (parts.length === 0) parts.push(`name=${err.name} stack=${err.stack ?? ""}`);
    return parts.join(" | ");
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function firstTopLevelString(body: Record<string, JsonValue>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// =============================================================================
// Referral programme (migration 0053)
// =============================================================================

// Hidden form fields the site may set when ?ref=CODE is present on the URL.
// Mable's site work captures the URL param into a hidden input; one of these
// names will land in body.data. `ref` is the canonical name; the others are
// safety nets if the site implementation lands on a different convention.
const REF_FORM_FIELD_NAMES = ["ref", "ref_code", "referral_code"] as const;

function extractRefCode(body: Record<string, JsonValue>): string | null {
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const dataObj = data as Record<string, JsonValue>;
  for (const name of REF_FORM_FIELD_NAMES) {
    const v = dataObj[name];
    if (typeof v === "string" && v.trim().length > 0) {
      // Crockford base32 codes are uppercase by convention; normalise so a
      // user pasting the link in lowercase still resolves.
      return v.trim().toUpperCase();
    }
  }
  return null;
}

interface ReferrerRow {
  id: number;
  email: string | null;
  phone: string | null;
  postcode: string | null;
  la: string | null;
}

async function processReferral(
  newSubmissionId: number,
  refCode: string,
  row: CanonicalSubmission,
): Promise<void> {
  // 1. Look up the referrer. If no match, the link was bad — silent skip.
  const referrers = await sql<Array<ReferrerRow>>`
    SELECT id, email, phone, postcode, la
      FROM leads.submissions
     WHERE referral_code = ${refCode}
       AND id <> ${newSubmissionId}
     LIMIT 1
  `;
  if (referrers.length === 0) {
    console.log(`referral: ref_code=${refCode} did not match any lead, ignoring`);
    return;
  }
  const referrer = referrers[0];

  // 2. Anti-fraud: self-referral by contact details.
  const sameEmail =
    !!row.email &&
    !!referrer.email &&
    normaliseEmailForCompare(row.email) === normaliseEmailForCompare(referrer.email);
  const samePhone =
    !!row.phone &&
    !!referrer.phone &&
    normalisePhoneForCompare(row.phone) === normalisePhoneForCompare(referrer.phone);
  // Address proxy: postcode (self-funded) or local authority (funded).
  const samePostcode =
    !!row.postcode &&
    !!referrer.postcode &&
    normalisePostcodeForCompare(row.postcode) === normalisePostcodeForCompare(referrer.postcode);
  const sameLa = !!row.la && !!referrer.la && row.la === referrer.la;
  const sameAddress = samePostcode || sameLa;

  // 3. Anti-fraud: friend's email already exists in the funnel as a fresh
  //    submission (parent_submission_id IS NULL excludes legitimate
  //    re-applications, which carry the parent's attribution and aren't novel
  //    introductions).
  let duplicateEmail = false;
  if (row.email) {
    const existing = await sql<Array<{ id: number }>>`
      SELECT id FROM leads.submissions
       WHERE LOWER(email) = LOWER(${row.email})
         AND id <> ${newSubmissionId}
         AND parent_submission_id IS NULL
       LIMIT 1
    `;
    duplicateEmail = existing.length > 0;
  }

  let fraudReason: string | null = null;
  if (sameEmail) fraudReason = "self_referral_email";
  else if (samePhone) fraudReason = "self_referral_phone";
  else if (sameAddress) fraudReason = "self_referral_address";
  else if (duplicateEmail) fraudReason = "duplicate_email_already_in_funnel";

  // 4. Insert the referral row inside a transaction. fraud_rejected → no
  //    referrer link on the submission. pending → set referrer_lead_id and
  //    create a pending referral row that the eligible-flip will pick up.
  await sql.begin(async (trx) => {
    await trx`SET LOCAL ROLE functions_writer`;

    if (fraudReason) {
      await trx`
        INSERT INTO leads.referrals (referrer_lead_id, referred_lead_id, voucher_status, fraud_reason)
        VALUES (${referrer.id}, ${newSubmissionId}, 'fraud_rejected', ${fraudReason})
        ON CONFLICT (referred_lead_id) DO NOTHING
      `;
      console.log(
        `referral: lead=${newSubmissionId} ref_code=${refCode} referrer=${referrer.id} → fraud_rejected (${fraudReason})`,
      );
      return;
    }

    await trx`
      UPDATE leads.submissions
         SET referrer_lead_id = ${referrer.id}
       WHERE id = ${newSubmissionId}
    `;
    await trx`
      INSERT INTO leads.referrals (referrer_lead_id, referred_lead_id, voucher_status)
      VALUES (${referrer.id}, ${newSubmissionId}, 'pending')
      ON CONFLICT (referred_lead_id) DO NOTHING
    `;
    console.log(
      `referral: lead=${newSubmissionId} ref_code=${refCode} referrer=${referrer.id} → pending`,
    );
  });
}

function normaliseEmailForCompare(s: string): string {
  return s.trim().toLowerCase();
}

function normalisePhoneForCompare(s: string): string {
  // Strip everything except digits. Country-code prefixes are tolerated by the
  // length difference catching duplicates anyway; this is a coarse check.
  return s.replace(/[^\d]/g, "");
}

function normalisePostcodeForCompare(s: string): string {
  return s.replace(/\s+/g, "").toUpperCase();
}
