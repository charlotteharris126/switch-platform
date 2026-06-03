// Edge Function: brevo-sms-event-webhook
//
// Receives transactional SMS delivery events from Brevo and updates the
// matching crm.sms_log row so "did the text reach the handset?" is answerable.
// Before this existed, sms_log only ever showed 'sent' (Brevo accepted the
// request) or 'failed' (our pre-send error) — never 'delivered'/'undelivered',
// so a text that Brevo accepted then silently failed at the carrier looked
// identical to one that landed.
//
// IMPORTANT — Brevo's transactional SMS webhook payload differs from the email
// one (do NOT assume the email shape):
//   - event type is in `msg_status` (NOT `event`)
//   - message id is `messageId` (an INTEGER; our brevo_message_id is TEXT, set
//     via String(messageId) in sendSms — so we String()-coerce here to match)
//   - recipient is `to`
// Exact msg_status values per Brevo docs (developers.brevo.com/docs/
// transactional-webhooks): sent, accepted, delivered, replied, soft_bounce,
// hard_bounce, subscribe, unsubscribed, skip, bl (blacklisted), rej (rejected).
//
// Side-effect, per recognised event matched by brevo_message_id:
//   - Update crm.sms_log.status to delivered / sent / undelivered
//   - Stamp sent_at on a delivered/sent event if not already set
//   - Capture the failure reason into error_text on a non-delivery
//   - Merge the raw event into metadata.last_event for forensics
//
// SMS-only: no consent_history / marketing_opt_in side-effects here (subscribe/
// unsubscribed events are ignored for now — SMS marketing consent is a separate
// channel; add deliberately if wanted later). replied is also ignored (not a
// delivery status, no column for it).
//
// Auth: mirrors brevo-event-webhook — shared-secret bearer token in the
// Authorization header. Uses BREVO_SMS_WEBHOOK_SECRET if set, else falls back
// to the shared BREVO_WEBHOOK_SECRET. Configure Brevo's SMS webhook with
// `Authorization: Bearer <secret>`. config.toml verify_jwt=false.
//
// The UPDATE runs over the base SUPABASE_DB_URL connection (postgres), same as
// brevo-event-webhook updates email_log — no functions_writer role switch.

import postgres from "npm:postgres@3";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
const WEBHOOK_SECRET =
  Deno.env.get("BREVO_SMS_WEBHOOK_SECRET") ?? Deno.env.get("BREVO_WEBHOOK_SECRET");

if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL is not set.");
}
if (!WEBHOOK_SECRET) {
  throw new Error("Neither BREVO_SMS_WEBHOOK_SECRET nor BREVO_WEBHOOK_SECRET is set.");
}

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 10,
  connect_timeout: 5,
  prepare: false,
});

// Map Brevo SMS msg_status → our crm.sms_log.status enum
// (queued | sent | failed | delivered | undelivered).
//
// 'accepted' (carrier accepted, pre-delivery) maps to 'sent'. All post-send
// non-deliveries map to 'undelivered' (our own pre-send 'failed' is set by
// sendSms and is never produced here). Events with no delivery meaning
// (replied, subscribe, unsubscribed) are intentionally absent → ignored.
// snake_case and camelCase variants both mapped in case an account differs.
const STATUS_MAP: Record<string, string> = {
  delivered:    "delivered",
  sent:         "sent",
  accepted:     "sent",
  soft_bounce:  "undelivered",
  softBounce:   "undelivered",
  hard_bounce:  "undelivered",
  hardBounce:   "undelivered",
  rej:          "undelivered",   // rejected
  rejected:     "undelivered",
  bl:           "undelivered",   // blacklisted
  blacklisted:  "undelivered",
  blocked:      "undelivered",
  skip:         "undelivered",   // Brevo skipped sending (e.g. suppression)
};

// Statuses meaning the message did NOT reach the handset — capture the reason.
const FAILURE_STATUSES = new Set(["undelivered"]);

interface BrevoSmsEvent {
  // SMS uses msg_status; keep `event` as a defensive fallback.
  msg_status?: string;
  event?: string;
  // messageId is an integer in SMS payloads; tolerate the email-style names too.
  messageId?: string | number;
  "message-id"?: string | number;
  message_id?: string | number;
  to?: string;
  reason?: string;
  ts_event?: number;
  [key: string]: unknown;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authenticate(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${WEBHOOK_SECRET}`;
  return constantTimeEqual(header, expected);
}

function extractMessageId(event: BrevoSmsEvent): string | undefined {
  const raw = event.messageId ?? event["message-id"] ?? event.message_id;
  return raw != null ? String(raw) : undefined;
}

function extractEventName(event: BrevoSmsEvent): string | undefined {
  return event.msg_status ?? event.event;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!authenticate(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: BrevoSmsEvent | BrevoSmsEvent[];
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request — invalid JSON", { status: 400 });
  }

  // Brevo can deliver one event per request OR an array. Normalise.
  const events: BrevoSmsEvent[] = Array.isArray(body) ? body : [body];

  const results = { processed: 0, ignored: 0, errors: 0 };

  for (const event of events) {
    try {
      const handled = await processEvent(event);
      if (handled) results.processed++;
      else results.ignored++;
    } catch (err) {
      console.error(
        "brevo-sms-event-webhook: event processing failed",
        { msg_status: extractEventName(event), messageId: extractMessageId(event) },
        err instanceof Error ? err.message : String(err),
      );
      results.errors++;
    }
  }

  return new Response(JSON.stringify(results), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

async function processEvent(event: BrevoSmsEvent): Promise<boolean> {
  const eventName = extractEventName(event);
  const messageId = extractMessageId(event);

  if (!eventName || typeof eventName !== "string") {
    console.warn("brevo-sms-event-webhook: event missing msg_status/event, skipping");
    return false;
  }

  const newStatus = STATUS_MAP[eventName];

  // Need both a recognised event AND a message_id to correlate. Unknown events
  // (replied, subscribe, unsubscribed, etc.) are ignored — not an error.
  if (!newStatus || !messageId) {
    return false;
  }

  const isFailure = FAILURE_STATUSES.has(newStatus);
  const reason = typeof event.reason === "string" ? event.reason.slice(0, 4000) : null;

  // One UPDATE: set status, stamp sent_at for delivered/sent if not already
  // set, write error_text on a non-delivery, merge raw event into metadata.
  // Matches brevo-event-webhook's email_log pattern (base connection, no role
  // switch). brevo_message_id is TEXT; messageId already String()-coerced.
  await sql`
    UPDATE crm.sms_log
       SET status     = ${newStatus},
           sent_at    = CASE
                          WHEN ${newStatus} IN ('delivered','sent') THEN COALESCE(sent_at, now())
                          ELSE sent_at
                        END,
           error_text = CASE
                          WHEN ${isFailure} THEN ${reason}
                          ELSE error_text
                        END,
           metadata   = COALESCE(metadata, '{}'::jsonb) || ${sql.json({
             last_event: eventName,
             last_event_at: new Date().toISOString(),
             raw: event,
           })}::jsonb
     WHERE brevo_message_id = ${messageId}
  `;

  return true;
}
