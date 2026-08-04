// Edge Function: provider-renotify
//
// Manually re-send the standard "new enquiry" provider notification for an
// already-routed lead. Exists for backfills / one-offs — e.g. leads that
// missed their notification because of the null-webhook regression (EMS portal
// cutover, S87). Not part of the normal routing path; that fires the
// notification inline via _shared/route-lead.ts routeLead.
//
// Auth: x-audit-key header matched against AUDIT_SHARED_SECRET (vault), same
// pattern as sms-chaser-attempt-1 / admin-notify-callback.
//
// Request: POST { "submission_id": 762 }
// Uses the shared sendProviderNotification, so the email is identical to the
// one the lead would have got at routing (portal-aware, PII-free, cc rules).

import postgres from "npm:postgres@3";
import {
  sendProviderNotification,
  SUBMISSION_FULL_COLUMNS,
  type ProviderRow,
  type SubmissionRow,
} from "../_shared/route-lead.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) throw new Error("SUPABASE_DB_URL not set");
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
  submission_id?: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

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

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const submissionId = typeof body.submission_id === "number" ? body.submission_id : null;
  if (!submissionId) return json({ error: "submission_id required" }, 400);

  let submission: SubmissionRow | undefined;
  try {
    [submission] = await sql<SubmissionRow[]>`
      SELECT ${sql.unsafe(SUBMISSION_FULL_COLUMNS)}
        FROM leads.submissions
       WHERE id = ${submissionId}
       LIMIT 1
    `;
  } catch (err) {
    return json({ error: `submission lookup failed: ${String(err)}` }, 500);
  }
  if (!submission) return json({ error: "submission not found" }, 404);
  if (!submission.primary_routed_to) {
    return json({ ok: true, status: "skipped", reason: "submission not routed" });
  }

  let provider: ProviderRow | undefined;
  try {
    [provider] = await sql<ProviderRow[]>`
      SELECT provider_id, company_name, contact_email, contact_name, contact_phone,
             sheet_id, sheet_webhook_url, crm_webhook_url, cc_emails,
             active, archived_at, auto_route_enabled,
             trust_line, regions, portal_enabled, regional_contacts
        FROM crm.providers
       WHERE provider_id = ${submission.primary_routed_to}
       LIMIT 1
    `;
  } catch (err) {
    return json({ error: `provider lookup failed: ${String(err)}` }, 500);
  }
  if (!provider) return json({ error: "routed provider not found" }, 404);

  // Standard new-enquiry notification (not the re_application branch).
  const result = await sendProviderNotification(sql, provider, submission, "auto_route");
  if (!result.ok) return json({ ok: false, status: "failed", error: result.error }, 502);
  return json({ ok: true, status: "sent", submission_id: submissionId, provider_id: provider.provider_id });
});
