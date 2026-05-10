// Edge Function: admin-test-email
//
// Manual re-fire of provider-facing transactional emails for testing.
// Currently supports the "New enquiry" routing notification. admin
// triggers this from /admin/leads/[id] on a demo lead to verify the
// email composition lands correctly without needing to create a fresh
// lead through the form.
//
// Auth: x-audit-key matched against AUDIT_SHARED_SECRET (vault).
//
// Body:
//   { "kind": "routing", "submission_id": 347 }
//
// Response:
//   { ok: true } | { ok: false, error: "..." }
//
// Notes:
//   - Reuses sendProviderNotification from _shared/route-lead.ts so the
//     email composition is the same as the real path.
//   - Skips the routing log + sheet-append + Brevo learner upsert. Just
//     fires the notification email.

import postgres from "npm:postgres@3";
import {
  type ProviderRow,
  type SubmissionRow,
  sendProviderNotification,
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

interface RequestBody {
  kind?: unknown;
  submission_id?: unknown;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Auth
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

  // Body
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const kind = typeof body.kind === "string" ? body.kind : null;
  const submissionId = typeof body.submission_id === "number" ? body.submission_id : null;
  if (!submissionId) return json({ error: "submission_id required" }, 400);

  if (kind !== "routing") {
    return json({ error: `unknown kind: ${kind}` }, 400);
  }

  // Lookup submission + its routed provider
  let submission: SubmissionRow | undefined;
  try {
    [submission] = await sql<SubmissionRow[]>`
      SELECT id, submitted_at, course_id, funding_category, funding_route,
             first_name, last_name, email, phone,
             la, region_scheme, age_band, employment_status,
             prior_level_3_or_higher, can_start_on_intake_date,
             outcome_interest, why_this_course,
             postcode, region, reason, interest, situation,
             session_id, source_form, schema_version,
             utm_source, utm_medium, utm_campaign, utm_term, utm_content,
             user_agent, page_url, referrer,
             ip_address, ip_country, ip_country_code,
             marketing_opt_in, terms_accepted, privacy_accepted,
             primary_routed_to, fastracked_at, client_nonce, parent_submission_id,
             archived_at, is_dq, dq_reason
        FROM leads.submissions
       WHERE id = ${submissionId}
    `;
  } catch (err) {
    return json({ error: `submission lookup failed: ${String(err)}` }, 500);
  }
  if (!submission) return json({ error: "submission not found" }, 404);
  if (!submission.primary_routed_to) {
    return json({ error: "submission is not routed to a provider yet" }, 400);
  }

  let provider: ProviderRow | undefined;
  try {
    [provider] = await sql<ProviderRow[]>`
      SELECT provider_id, company_name, contact_email, contact_name,
             sheet_id, sheet_webhook_url, crm_webhook_url, cc_emails,
             active, archived_at, auto_route_enabled,
             trust_line, regions, portal_enabled
        FROM crm.providers
       WHERE provider_id = ${submission.primary_routed_to}
    `;
  } catch (err) {
    return json({ error: `provider lookup failed: ${String(err)}` }, 500);
  }
  if (!provider) return json({ error: "routed provider not found" }, 404);

  const result = await sendProviderNotification(provider, submission, "auto_route");
  if (!result.ok) {
    return json({ ok: false, error: result.error }, 500);
  }
  return json({
    ok: true,
    sent_to: provider.contact_email,
    portal_link_used: provider.portal_enabled,
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
