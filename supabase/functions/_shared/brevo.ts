// Shared Brevo helper.
//
// Used by:
//   - netlify-lead-router  — sends the rich owner notification email with confirm links (SwitchLeads brand)
//   - routing-confirm      — sends provider notification ("new enquiry, check sheet"),
//                             owner fallback ("sheet append failed, paste manually"),
//                             AND upserts the learner as a Brevo contact + adds to lists
//                             so Brevo Automations can run the Switchable utility + nurture
//                             sequences (Switchable brand, learner-facing).
//
// Secrets expected in env:
//   BREVO_API_KEY                  — transactional + contacts API key from Brevo dashboard
//   BREVO_SENDER_EMAIL             — SwitchLeads verified sender (e.g. charlotte@switchleads.co.uk)
//   BREVO_SENDER_EMAIL_SWITCHABLE  — Switchable verified sender (e.g. hello@switchable.org.uk)
//   BREVO_LIST_ID_SWITCHABLE_UTILITY  — list ID for Switchable utility stream (contract basis)
//   BREVO_LIST_ID_SWITCHABLE_NURTURE  — list ID for Switchable nurture stream (consent basis)
//
// On error, the caller is responsible for logging to leads.dead_letter.
// This helper surfaces the failure plainly and does not retry.
//
// On Brevo Automations triggers: this helper deliberately does not implement
// a generic "fire event" path. Brevo Automations can be triggered cleanly by
// attribute updates on a contact (e.g. SW_MATCH_STATUS=matched), which is what
// upsertBrevoContact does. Using attribute-driven triggers keeps the integration
// inside the standard Contacts API (BREVO_API_KEY, api.brevo.com/v3) and avoids
// the separate Marketing Automation Track endpoint which needs its own ma-key
// and tracker ID. If a future automation genuinely needs an event-stream model
// rather than an attribute model, add fireBrevoEvent then — not before.
//
// Attribute namespacing convention (decided 2026-04-29):
//   - FIRSTNAME / LASTNAME stay as unprefixed Brevo defaults.
//   - Switchable-brand attributes prefix with SW_ (e.g. SW_COURSE_NAME).
//   - SwitchLeads-brand attributes prefix with SL_ (e.g. SL_PILOT_STATUS).
// One email = one Brevo contact across both brands; namespacing prevents
// brand-specific fields colliding on shared records.

const BREVO_TRANSACTIONAL_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
const BREVO_CONTACTS_ENDPOINT = "https://api.brevo.com/v3/contacts";

// Defensive hard cap on any single Brevo call. Prior behaviour (no timeout) made
// a slow Brevo response block the caller for the full Edge Function 25s budget.
// In netlify-lead-router that meant Netlify's webhook timed out and, after 6
// consecutive failures, Netlify auto-disabled the whole webhook. We now accept
// that a rare slow Brevo call costs one missed email (recoverable) rather than
// risking the webhook (not recoverable). See changelog 2026-04-21 Session 3.3.
const BREVO_TIMEOUT_MS = 5000;

export type BrevoBrand = "switchleads" | "switchable";

interface BrandConfig {
  senderEmailEnv: string;
  senderName: string;
}

const BRANDS: Record<BrevoBrand, BrandConfig> = {
  switchleads: { senderEmailEnv: "BREVO_SENDER_EMAIL", senderName: "SwitchLeads" },
  switchable:  { senderEmailEnv: "BREVO_SENDER_EMAIL_SWITCHABLE", senderName: "Switchable" },
};

export interface BrevoEmail {
  to: Array<{ email: string; name?: string }>;
  cc?: Array<{ email: string; name?: string }>;
  bcc?: Array<{ email: string; name?: string }>;
  subject: string;
  htmlContent: string;
  textContent?: string;
  replyTo?: { email: string; name?: string };
  tags?: string[];
  /** Sender selection. Defaults to "switchleads" for backward compatibility. */
  brand?: BrevoBrand;
}

export interface BrevoResult {
  ok: boolean;
  messageId?: string;
  status?: number;
  error?: string;
}

export async function sendBrevoEmail(email: BrevoEmail): Promise<BrevoResult> {
  const apiKey = Deno.env.get("BREVO_API_KEY");
  if (!apiKey) return { ok: false, error: "BREVO_API_KEY not set" };

  const brand = email.brand ?? "switchleads";
  const cfg = BRANDS[brand];
  const senderEmail = Deno.env.get(cfg.senderEmailEnv);
  if (!senderEmail) return { ok: false, error: `${cfg.senderEmailEnv} not set` };

  const body = {
    sender: { email: senderEmail, name: cfg.senderName },
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    subject: email.subject,
    htmlContent: email.htmlContent,
    textContent: email.textContent ?? stripHtml(email.htmlContent),
    replyTo: email.replyTo,
    tags: email.tags,
  };

  const res = await fetchBrevo(BREVO_TRANSACTIONAL_ENDPOINT, "POST", apiKey, body);
  if (!res.ok) return res;

  try {
    const data = await res.response!.json() as { messageId?: string };
    return { ok: true, messageId: data.messageId, status: res.status };
  } catch {
    return { ok: true, status: res.status };
  }
}

// =============================================================================
// Contacts API
// =============================================================================

/**
 * Brevo contact attributes. Keys are uppercased Brevo attribute names
 * (FIRSTNAME, COURSE_NAME, etc.). Values are coerced by Brevo to the type
 * configured for the attribute in the dashboard (text, number, date, boolean,
 * category). Pass strings unless the attribute is genuinely numeric/boolean.
 */
export type BrevoAttributes = Record<string, string | number | boolean | null>;

export interface UpsertContactArgs {
  email: string;
  attributes?: BrevoAttributes;
  /** Optional list IDs to add the contact to in the same call. */
  listIds?: number[];
}

/**
 * Upsert a contact by email. Creates if missing, updates attributes if present.
 * Brevo's `updateEnabled: true` makes the POST idempotent on email.
 *
 * Returns ok: true on 201 (created) or 204 (updated). Returns the raw error
 * body on failure for the caller to log into leads.dead_letter.
 */
export async function upsertBrevoContact(args: UpsertContactArgs): Promise<BrevoResult> {
  const apiKey = Deno.env.get("BREVO_API_KEY");
  if (!apiKey) return { ok: false, error: "BREVO_API_KEY not set" };
  if (!args.email) return { ok: false, error: "email required" };

  const body: Record<string, unknown> = {
    email: args.email,
    updateEnabled: true,
  };
  if (args.attributes) body.attributes = args.attributes;
  if (args.listIds && args.listIds.length > 0) body.listIds = args.listIds;

  return await fetchBrevo(BREVO_CONTACTS_ENDPOINT, "POST", apiKey, body);
}

/**
 * Add an existing contact to an additional Brevo list. Use when the contact
 * already exists (e.g. flipping a learner from utility-only to nurture-included
 * after they later opt in).
 *
 * For first-time contact creation, prefer upsertBrevoContact with listIds
 * passed in the same call — it's one API hit instead of two.
 */
export async function addBrevoContactToList(args: { email: string; listId: number }): Promise<BrevoResult> {
  const apiKey = Deno.env.get("BREVO_API_KEY");
  if (!apiKey) return { ok: false, error: "BREVO_API_KEY not set" };
  if (!args.email) return { ok: false, error: "email required" };
  if (!args.listId) return { ok: false, error: "listId required" };

  const url = `${BREVO_CONTACTS_ENDPOINT}/lists/${args.listId}/contacts/add`;
  return await fetchBrevo(url, "POST", apiKey, { emails: [args.email] });
}

// =============================================================================
// Internal
// =============================================================================

interface InternalResult extends BrevoResult {
  /** Raw Response object — kept on success so the caller can inspect the body. */
  response?: Response;
}

async function fetchBrevo(
  url: string,
  method: string,
  apiKey: string,
  body: unknown,
): Promise<InternalResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BREVO_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
        "accept": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      return { ok: false, error: `brevo timeout after ${BREVO_TIMEOUT_MS}ms` };
    }
    return { ok: false, error: `fetch failed: ${String(err)}` };
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "<body unreadable>");
    return { ok: false, status: res.status, error: `brevo ${res.status}: ${text.slice(0, 500)}` };
  }

  return { ok: true, status: res.status, response: res };
}

function stripHtml(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n")
             .replace(/<\/p>/gi, "\n\n")
             .replace(/<[^>]+>/g, "")
             .replace(/&nbsp;/g, " ")
             .replace(/&amp;/g, "&")
             .replace(/&lt;/g, "<")
             .replace(/&gt;/g, ">")
             .replace(/\n{3,}/g, "\n\n")
             .trim();
}
