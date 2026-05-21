// Edge Function: admin-test-sms
//
// Manual re-fire of the sendSms helper for verifying Chunk 1 of the SMS
// utility build. Bypasses the trigger gates (no SW_FASTRACK_COMPLETED check,
// no provider opt-out check, no funding-category filter) so the test surface
// is just "does the helper write a sms_log row, call Brevo, and come back
// clean". Wired triggers (Chunks 2 + 3) layer their own gates on top.
//
// Auth: x-audit-key matched against AUDIT_SHARED_SECRET (vault).
//
// Body:
//   {
//     "submission_id": 347,
//     "comm_type": "call_reminder_save_number",   // one of the three
//     "phone": "+447123456789",                   // optional override; defaults to submission.phone
//     "body": "Hi Catherine, ..."                 // optional override; defaults to a marker test string
//   }
//
// Response:
//   { ok: true, sms_log_id: 12, brevo_message_id: "...", status: "sent", shadow_mode: true }
//
// Notes:
//   - Uses the sendSms helper from _shared/brevo.ts. Idempotency on
//     (submission_id, comm_type) still applies — re-running for the same
//     pair returns status="skipped_duplicate". Pick a fresh submission_id +
//     comm_type combo per test, or DELETE the sms_log row between runs.
//   - In shadow mode (BREVO_SMS_SHADOW_MODE=true, the default), the row
//     lands with status='sent' but no actual SMS goes out and
//     brevo_message_id stays NULL. Flip env to "false" to verify a real
//     send against a known phone.

import postgres from "npm:postgres@3";
import { sendSms, type SmsLogType } from "../_shared/brevo.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL not set");
}
const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 20, prepare: false });

const ALLOWED_COMM_TYPES = new Set<SmsLogType>([
  "call_reminder_fastrack_link",
  "call_reminder_save_number",
  "chaser_call_attempt",
]);

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
  comm_type?: unknown;
  phone?: unknown;
  body?: unknown;
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

  const commType = typeof body.comm_type === "string" ? body.comm_type : null;
  if (!commType || !ALLOWED_COMM_TYPES.has(commType as SmsLogType)) {
    return json({
      error: `comm_type must be one of: ${[...ALLOWED_COMM_TYPES].join(", ")}`,
    }, 400);
  }

  const phoneOverride = typeof body.phone === "string" ? body.phone.trim() : null;
  const bodyOverride = typeof body.body === "string" ? body.body : null;

  // Look up submission for the phone fallback. FK on crm.sms_log.submission_id
  // means the row has to exist regardless.
  let submission: { id: number; phone: string | null; first_name: string | null } | undefined;
  try {
    [submission] = await sql<Array<{ id: number; phone: string | null; first_name: string | null }>>`
      SELECT id, phone, first_name
        FROM leads.submissions
       WHERE id = ${submissionId}
    `;
  } catch (err) {
    return json({ error: `submission lookup failed: ${String(err)}` }, 500);
  }
  if (!submission) return json({ error: "submission not found" }, 404);

  const recipientPhone = phoneOverride ?? submission.phone;
  if (!recipientPhone) {
    return json({
      error: "no phone available — submission.phone is NULL and no phone override provided",
    }, 400);
  }

  const renderedBody = bodyOverride
    ?? `Hi ${submission.first_name ?? "there"}, this is an admin-test-sms send for sms_log verification. Submission #${submission.id}, comm_type ${commType}.`;

  const result = await sendSms({
    sql,
    submissionId,
    commType: commType as SmsLogType,
    recipientPhone,
    body: renderedBody,
    tag: "admin-test-sms",
    metadata: { source: "admin-test-sms" },
  });

  return json({
    ok: result.ok,
    status: result.status,
    sms_log_id: result.smsLogId,
    brevo_message_id: result.brevoMessageId,
    shadow_mode: result.shadowMode,
    error: result.error,
  }, result.ok ? 200 : 500);
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
