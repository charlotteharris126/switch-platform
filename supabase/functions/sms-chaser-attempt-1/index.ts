// Edge Function: sms-chaser-attempt-1
//
// Chunk 2 of SMS utility build. Fires the chaser SMS (Trigger C) when a
// provider marks an `attempt_1_no_answer` outcome in the portal. Wired
// from the server action `markOutcomeAction` via the RPC
// `crm.fire_sms_chaser_attempt_1` → `net.http_post` to this URL. Mirrors
// the email chaser dispatch pattern (`crm.fire_provider_chaser` →
// `admin-brevo-chase`).
//
// Fires ONCE per submission via the sendSms idempotency check on
// (submission_id, 'chaser_call_attempt'). Subsequent attempt_2 / attempt_3
// / cannot_reach transitions do NOT fire another SMS — the email chaser
// still fires on each one per the existing markOutcomeAction logic.
//
// Auth: x-audit-key matched against AUDIT_SHARED_SECRET (vault). Same
// pattern as admin-test-sms / admin-test-email / admin-brevo-chase.
//
// Body:
//   { "submission_id": 347 }
//
// Response:
//   { ok: true, status: "sent" | "skipped_duplicate" | ..., sms_log_id?, brevo_message_id?, shadow_mode }
//
// Best-effort posture: failure logs to leads.dead_letter via sendSms's
// persist path. The server action's existing email-chaser RPC isn't
// affected.

import postgres from "npm:postgres@3";
import { fireChaserSms } from "../_shared/sms-utility.ts";
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

interface RequestBody {
  submission_id?: unknown;
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
      SELECT provider_id, company_name, contact_email, contact_name,
             sheet_id, sheet_webhook_url, crm_webhook_url, cc_emails,
             active, archived_at, auto_route_enabled,
             trust_line, regions, portal_enabled, regional_contacts
        FROM crm.providers
       WHERE provider_id = ${submission.primary_routed_to}
    `;
  } catch (err) {
    return json({ error: `provider lookup failed: ${String(err)}` }, 500);
  }
  if (!provider) return json({ error: "routed provider not found" }, 404);

  const outcome = await fireChaserSms({ sql, submission, provider });
  if (outcome.kind === "skipped") {
    return json({ ok: true, status: "skipped", reason: outcome.reason });
  }
  return json({
    ok: outcome.result.ok,
    status: outcome.result.status,
    sms_log_id: outcome.result.smsLogId,
    brevo_message_id: outcome.result.brevoMessageId,
    shadow_mode: outcome.result.shadowMode,
    error: outcome.result.error,
  }, outcome.result.ok ? 200 : 500);
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
