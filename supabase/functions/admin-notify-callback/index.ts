// Edge Function: admin-notify-callback
//
// Fired by the admin Server Action that raises a callback flag on a lead.
// Looks up all active provider_users for the lead's provider and sends each
// of them a "Lead update from Switchable" email containing the admin's note
// + a deep link to the lead detail in the portal.
//
// Architecture: Brevo creds (BREVO_API_KEY, BREVO_SENDER_EMAIL_SWITCHABLE)
// already live in Edge Function env, so the Next.js Server Action POSTs
// here instead of calling Brevo directly. Avoids duplicating Brevo creds
// across Netlify env.
//
// Auth: x-audit-key header matched against AUDIT_SHARED_SECRET (read from
// vault via public.get_shared_secret). Same pattern as admin-brevo-resync.
//
// Body shape:
//   {
//     "provider_id": "demo-provider-ltd",
//     "submission_id": 347,
//     "note_body": "Aisha rang and wants a callback Tuesday morning."
//   }
//
// Response shape:
//   { "ok": true, "sent": 1, "skipped": 0 }
//   { "ok": false, "error": "..." }
//
// Skipping is per-recipient (e.g. one of two provider_users has no email).
// Per-recipient failures land as console.error here AND are reflected in
// the response.skipped count, but the function still returns ok:true if at
// least one recipient succeeded. Caller (Server Action) surfaces the
// counts to the admin UI if useful.

import postgres from "npm:postgres@3";
import { sendBrevoEmail } from "../_shared/brevo.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL not set (should be auto-injected by Supabase)");
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

interface ProviderUser {
  contact_email: string;
  display_name: string | null;
}

interface RequestBody {
  provider_id?: unknown;
  submission_id?: unknown;
  note_body?: unknown;
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
    return json({ error: "AUDIT_SHARED_SECRET not retrievable from vault" }, 500);
  }
  if (!providedKey || providedKey !== expectedKey) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: RequestBody;
  try {
    body = await req.json() as RequestBody;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const providerId = typeof body.provider_id === "string" ? body.provider_id : null;
  const submissionId = typeof body.submission_id === "number" ? body.submission_id : null;
  const noteBody = typeof body.note_body === "string" ? body.note_body : null;

  if (!providerId || !submissionId || !noteBody) {
    return json({ error: "provider_id, submission_id, note_body all required" }, 400);
  }
  if (noteBody.trim().length === 0) {
    return json({ error: "note_body must be non-empty" }, 400);
  }

  // Look up active provider_users for the provider.
  let recipients: ProviderUser[];
  try {
    recipients = await sql<ProviderUser[]>`
      SELECT contact_email, display_name
        FROM crm.provider_users
       WHERE provider_id = ${providerId}
         AND status = 'active'
    `;
  } catch (err) {
    console.error("provider_users lookup failed:", String(err));
    return json({ error: "provider_users lookup failed" }, 500);
  }

  if (recipients.length === 0) {
    // No-op success: no active users to notify, but the flag still raised.
    return json({ ok: true, sent: 0, skipped: 0, note: "no active provider_users" });
  }

  const portalUrl = `https://app.switchleads.co.uk/leads/${submissionId}`;
  const subject = `Lead #${submissionId} update from Switchable`;
  const html = composeHtml({ submissionId, noteBody, portalUrl });

  let sent = 0;
  let skipped = 0;
  const errors: Array<{ email: string; error: string }> = [];

  for (const r of recipients) {
    if (!r.contact_email) {
      skipped += 1;
      continue;
    }
    const result = await sendBrevoEmail({
      brand: "switchable",
      to: [{ email: r.contact_email, name: r.display_name ?? r.contact_email }],
      subject,
      htmlContent: html,
      tags: ["admin-notify-callback"],
    });
    if (result.ok) {
      sent += 1;
    } else {
      console.error(
        `Brevo send failed for ${r.contact_email}: ${result.error ?? "unknown"} (status ${result.status ?? "n/a"})`,
      );
      errors.push({ email: r.contact_email, error: result.error ?? "unknown" });
      skipped += 1;
    }
  }

  return json({
    ok: sent > 0 || recipients.length === 0,
    sent,
    skipped,
    ...(errors.length > 0 ? { errors } : {}),
  });
});

function composeHtml(args: {
  submissionId: number;
  noteBody: string;
  portalUrl: string;
}): string {
  const escapedNote = escapeHtml(args.noteBody).replace(/\n/g, "<br>");
  return `
<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0f172a; line-height: 1.5; padding: 16px; max-width: 560px;">
  <p>Hi,</p>
  <p>Lead <strong>#${args.submissionId}</strong> has been in touch.</p>
  <div style="margin: 16px 0; padding: 14px 16px; background: #fef3c7; border: 1px solid #fcd34d; border-radius: 6px;">
    <p style="margin: 0 0 4px 0; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #92400e;">Note from Switchable</p>
    <p style="margin: 0; color: #78350f; white-space: pre-wrap;">${escapedNote}</p>
  </div>
  <p style="margin: 24px 0;">
    <a href="${args.portalUrl}" style="display: inline-block; padding: 10px 18px; background: #0f172a; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">
      Open the lead in your portal
    </a>
  </p>
  <p>Open it to follow up.</p>
  <p style="margin-top: 32px; color: #64748b;">Switchable</p>
</body></html>
  `.trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
