// Edge Function: brevo-event-webhook
//
// Receives webhook events from Brevo (email delivery, opens, clicks, hard
// bounces, soft bounces, spam complaints, unsubscribes) and translates each
// event into the right side-effect:
//
//   - Update `crm.email_log.status` for the matching brevo_message_id row
//   - For unsubscribe / spam complaint: append a row to `crm.consent_history`
//     and flip `SW_CONSENT_MARKETING` to false on the contact in Brevo
//     (deferred to Phase 3 — Phase 1 only logs the consent_history row;
//     Phase 3's _shared/brevo.ts upgrade will handle the round-trip)
//
// Auth: Brevo's public docs do not document HMAC payload signing, so we use
// a shared-secret bearer token in the Authorization header. Brevo's webhook
// dashboard supports custom headers per webhook. Configure Brevo with
// `Authorization: Bearer <BREVO_WEBHOOK_SECRET>` and the function checks
// constant-time against the env var.
//
// Phase 1 of the email platform rearchitecture. Spec at
// platform/docs/email-platform-rearchitecture-spec.md.

import postgres from "npm:postgres@3";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
const WEBHOOK_SECRET = Deno.env.get("BREVO_WEBHOOK_SECRET");

if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL is not set.");
}
if (!WEBHOOK_SECRET) {
  throw new Error("BREVO_WEBHOOK_SECRET is not set.");
}

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 10,
  connect_timeout: 5,
  prepare: false,
});

// Map Brevo event names → our crm.email_log.status enum.
//
// Brevo's webhook payload uses lowercase, snake-case event names. The UI in
// Brevo's dashboard labels some of them differently (e.g. UI says "Complaint"
// while the payload field is "spam"; UI says "Clicked" while the payload field
// is "click"). Both name variants are mapped where ambiguous so a future Brevo
// rename doesn't silently drop events.
//
// Events not mapped (deferred, sent, first_opening, proxy_open, error) are
// expected to be left OFF in the Brevo dashboard. If they arrive anyway they
// land in metadata.last_event but don't change status.
const EVENT_TO_STATUS: Record<string, string> = {
  delivered:        "delivered",
  hard_bounce:      "bounced_hard",
  hardBounce:       "bounced_hard",   // camelCase variant seen in some Brevo accounts
  soft_bounce:      "bounced_soft",
  softBounce:       "bounced_soft",
  blocked:          "bounced_hard",   // Brevo refused to send (suppression list etc.) — treat as hard bounce semantically
  invalid_email:    "bounced_hard",   // bad address — same as hard bounce
  invalidEmail:     "bounced_hard",
  opened:           "opened",
  uniqueOpened:     "opened",
  unique_opened:    "opened",
  click:            "clicked",
  clicked:          "clicked",
  spam:             "complained",
  complaint:        "complained",     // UI label variant
  unsubscribed:     "complained",     // we log unsubscribe in consent_history; complained captures the email_log side
};

// Consent-affecting events. These trigger a consent_history insert in addition
// to the email_log status update. Both UI/payload name variants covered.
const CONSENT_EVENTS = new Set(["unsubscribed", "spam", "complaint"]);

interface BrevoEvent {
  event?: string;
  email?: string;
  "message-id"?: string;
  date?: string;
  ts?: number;
  // We pass everything else through to email_log.metadata for forensic value.
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

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!authenticate(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: BrevoEvent | BrevoEvent[];
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request — invalid JSON", { status: 400 });
  }

  // Brevo can deliver one event per request OR an array. Normalise.
  const events: BrevoEvent[] = Array.isArray(body) ? body : [body];

  const results = { processed: 0, ignored: 0, errors: 0 };

  for (const event of events) {
    try {
      await processEvent(event);
      results.processed++;
    } catch (err) {
      console.error(
        "brevo-event-webhook: event processing failed",
        { event: event.event, messageId: event["message-id"] },
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

async function processEvent(event: BrevoEvent): Promise<void> {
  const eventName = event.event;
  const messageId = event["message-id"];
  const recipientEmail = event.email;

  if (!eventName || typeof eventName !== "string") {
    console.warn("brevo-event-webhook: event missing 'event' field, skipping");
    return;
  }

  const newStatus = EVENT_TO_STATUS[eventName];

  // Update email_log status (if we recognise the event AND have a message_id
  // to correlate against). Unknown events still get a consent_history row if
  // applicable, but we don't UPDATE without a target row.
  if (newStatus && messageId) {
    await sql`
      UPDATE crm.email_log
      SET status = ${newStatus},
          metadata = COALESCE(metadata, '{}'::jsonb) || ${sql.json({
            last_event: eventName,
            last_event_at: new Date().toISOString(),
            raw: event,
          })}::jsonb
      WHERE brevo_message_id = ${messageId}
    `;
  }

  // Consent state changes (unsubscribe / spam) — log to consent_history.
  // submission_id is best-effort: look up most recent submission with this email.
  if (CONSENT_EVENTS.has(eventName) && recipientEmail) {
    const subRows = await sql<{ id: number }[]>`
      SELECT id FROM leads.submissions
      WHERE LOWER(email) = LOWER(${recipientEmail})
      ORDER BY submitted_at DESC
      LIMIT 1
    `;
    const submissionId = subRows.length > 0 ? subRows[0].id : null;

    await sql`
      INSERT INTO crm.consent_history (
        submission_id,
        contact_email,
        field_changed,
        old_value,
        new_value,
        changed_by,
        source,
        metadata
      ) VALUES (
        ${submissionId},
        ${recipientEmail.toLowerCase()},
        'SW_CONSENT_MARKETING',
        'true',
        'false',
        'contact',
        ${eventName === "spam" ? "spam_complaint" : "unsubscribe_link"},
        ${sql.json({ raw: event })}
      )
    `;

    // Note: flipping SW_CONSENT_MARKETING in Brevo + Supabase happens in
    // Phase 3's _shared/brevo.ts upgrade. Phase 1 only logs the event.
  }
}
