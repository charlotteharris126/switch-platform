// Shared Brevo (transactional email) helper.
//
// Used by:
//   - netlify-lead-router — sends the rich owner notification email with confirm links
//   - routing-confirm     — sends provider notification ("new enquiry, check sheet")
//                            and owner fallback ("sheet append failed, paste manually")
//
// Secrets expected in env:
//   BREVO_API_KEY        — transactional API key from Brevo dashboard
//   BREVO_SENDER_EMAIL   — verified sender address (e.g. charlotte@switchleads.co.uk)
//
// On error, the caller is responsible for logging to leads.dead_letter.
// This helper surfaces the failure plainly and does not retry.

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

// Defensive hard cap on any single Brevo call. Prior behaviour (no timeout) made
// a slow Brevo response block the caller for the full Edge Function 25s budget.
// In netlify-lead-router that meant Netlify's webhook timed out and, after 6
// consecutive failures, Netlify auto-disabled the whole webhook. We now accept
// that a rare slow Brevo call costs one missed email (recoverable) rather than
// risking the webhook (not recoverable). See changelog 2026-04-21 Session 3.3.
const BREVO_TIMEOUT_MS = 5000;

export interface BrevoEmail {
  to: Array<{ email: string; name?: string }>;
  cc?: Array<{ email: string; name?: string }>;
  bcc?: Array<{ email: string; name?: string }>;
  subject: string;
  htmlContent: string;
  textContent?: string;
  replyTo?: { email: string; name?: string };
  tags?: string[];
}

export interface BrevoResult {
  ok: boolean;
  messageId?: string;
  status?: number;
  error?: string;
}

export async function sendBrevoEmail(email: BrevoEmail): Promise<BrevoResult> {
  const apiKey = Deno.env.get("BREVO_API_KEY");
  const senderEmail = Deno.env.get("BREVO_SENDER_EMAIL");
  if (!apiKey) return { ok: false, error: "BREVO_API_KEY not set" };
  if (!senderEmail) return { ok: false, error: "BREVO_SENDER_EMAIL not set" };

  const body = {
    sender: { email: senderEmail, name: "SwitchLeads" },
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    subject: email.subject,
    htmlContent: email.htmlContent,
    textContent: email.textContent ?? stripHtml(email.htmlContent),
    replyTo: email.replyTo,
    tags: email.tags,
  };

  let res: Response;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BREVO_TIMEOUT_MS);
  try {
    res = await fetch(BREVO_ENDPOINT, {
      method: "POST",
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

  try {
    const data = await res.json() as { messageId?: string };
    return { ok: true, messageId: data.messageId, status: res.status };
  } catch {
    // Brevo returned 2xx with unexpected body; treat as success anyway.
    return { ok: true, status: res.status };
  }
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
