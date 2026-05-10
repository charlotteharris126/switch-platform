// Minimal Brevo transactional email helper for Server Actions.
//
// Mirrors the Deno-side helper in supabase/functions/_shared/brevo.ts but
// uses fetch directly. Best-effort: failures log + return false but
// don't throw, so the Server Action that called it stays decoupled from
// Brevo availability.
//
// Two send modes:
//   - templateId: numeric — Brevo template defines the HTML, params
//     interpolate into placeholders. Used when you want to edit copy
//     without a code change.
//   - htmlContent: string — HTML body composed in code, sent as-is.
//     Use for short transactional nudges where keeping copy in the
//     repo (and in source control) beats Brevo dashboard edits.
//
// Dormancy: if BREVO_API_KEY is missing from the Netlify env, this
// no-ops silently. Same pattern as the Edge Function templates.

interface BaseArgs {
  to: { email: string; name?: string };
  /** Optional sender override. Falls back to BREVO_SENDER_EMAIL + BREVO_SENDER_NAME envs. */
  sender?: { email: string; name?: string };
  subject?: string;
}

interface TemplateSendArgs extends BaseArgs {
  templateId: number;
  params?: Record<string, string | number | boolean | null>;
  htmlContent?: never;
}

interface HtmlSendArgs extends BaseArgs {
  templateId?: never;
  params?: never;
  htmlContent: string;
  subject: string;
}

type SendArgs = TemplateSendArgs | HtmlSendArgs;

export async function sendTransactional(args: SendArgs): Promise<boolean> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn("[sendTransactional] BREVO_API_KEY not set — skipping");
    return false;
  }

  // Resolve sender. Caller override wins; otherwise env vars.
  const senderEmail = args.sender?.email ?? process.env.BREVO_SENDER_EMAIL;
  const senderName = args.sender?.name ?? process.env.BREVO_SENDER_NAME;
  if (!senderEmail) {
    console.warn("[sendTransactional] No sender resolved (set BREVO_SENDER_EMAIL or pass args.sender) — skipping");
    return false;
  }

  // Compose request body — template OR raw HTML, never both.
  const body: Record<string, unknown> = {
    sender: { email: senderEmail, ...(senderName ? { name: senderName } : {}) },
    to: [{ email: args.to.email, ...(args.to.name ? { name: args.to.name } : {}) }],
  };
  if ("templateId" in args && args.templateId != null) {
    if (!Number.isFinite(args.templateId) || args.templateId <= 0) {
      console.warn(`[sendTransactional] Invalid templateId=${args.templateId} — skipping`);
      return false;
    }
    body.templateId = args.templateId;
    if (args.params) body.params = args.params;
    if (args.subject) body.subject = args.subject;
  } else {
    body.subject = args.subject;
    body.htmlContent = args.htmlContent;
  }

  try {
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const respBody = await resp.text().catch(() => "");
      console.error(
        `[sendTransactional] Brevo ${resp.status} → ${args.to.email}: ${respBody.slice(0, 200)}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[sendTransactional] fetch failed → ${args.to.email}: ${String(err)}`);
    return false;
  }
}
