// Edge Function: admin-notify-callback
//
// Fired by the admin Server Action that raises a callback flag on a lead.
//
// Recipient model (mirrors _shared/route-lead.ts sendProviderNotification):
//   TO:  every active crm.provider_users row for the provider whose
//        notification_las matches the lead's la (NULL/empty = catch-all,
//        always matches). One email, multiple TO recipients — team
//        members see each other on the thread.
//   CC:  the owner (Charlotte) + provider.cc_emails. Deduped against TO.
//
// Each recipient gets one email containing the admin's note + a deep
// link to the lead detail in the portal.
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
//   { "ok": true, "sent": 1, "to": 1, "cc": 2 }
//   { "ok": false, "error": "..." }

import postgres from "npm:postgres@3";
import { sendBrevoEmail } from "../_shared/brevo.ts";
import { fetchAreaScopedProviderUsers, buildCcList } from "../_shared/route-lead.ts";
import { getOwnerEmail } from "../_shared/owner-email.ts";

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

  // Look up the lead's LA + the provider's cc_emails in one round-trip each.
  let leadLa: string | null = null;
  let providerCcEmails: string[] = [];
  try {
    const [row] = await sql<Array<{ la: string | null }>>`
      SELECT la FROM leads.submissions WHERE id = ${submissionId}
    `;
    if (!row) return json({ error: `submission ${submissionId} not found` }, 404);
    leadLa = row.la;

    const [providerRow] = await sql<Array<{ cc_emails: string[] | null }>>`
      SELECT cc_emails FROM crm.providers WHERE provider_id = ${providerId}
    `;
    providerCcEmails = providerRow?.cc_emails ?? [];
  } catch (err) {
    console.error("lead/provider lookup failed:", String(err));
    return json({ error: "lead/provider lookup failed" }, 500);
  }

  // Recipients: active provider_users matching the lead's LA (NULL/empty =
  // catch-all). Single source of truth shared with sendProviderNotification.
  const recipients = await fetchAreaScopedProviderUsers(sql, providerId, leadLa);

  if (recipients.length === 0) {
    // No active users matched. Flag still raised; nothing to email.
    return json({ ok: true, sent: 0, to: 0, cc: 0, note: "no matching provider_users" });
  }

  const ownerEmail = getOwnerEmail() ?? undefined;
  // buildCcList dedups CC against the TO addresses we pass via the
  // first recipient. We build the full TO set separately and pass the
  // first TO as the dedup anchor; remaining TO emails are added to the
  // dedup set inline.
  const toList = recipients;
  const dedupAnchorTo = toList[0]?.email;
  const ccList = buildCcList(ownerEmail, providerCcEmails, [], dedupAnchorTo);
  // Manually dedup the rest of the TO list out of CC (buildCcList only
  // knew about the first TO).
  const toEmailsLower = new Set(toList.map((t) => t.email.trim().toLowerCase()));
  const filteredCc = ccList.filter((c) => !toEmailsLower.has(c.email.trim().toLowerCase()));

  const portalUrl = `https://app.switchleads.co.uk/leads/${submissionId}`;
  const subject = `Lead #${submissionId} update from Switchable`;
  const html = composeHtml({ submissionId, noteBody, portalUrl });

  const result = await sendBrevoEmail({
    brand: "switchable",
    to: toList,
    cc: filteredCc.length > 0 ? filteredCc : undefined,
    subject,
    htmlContent: html,
    tags: ["admin-notify-callback"],
  });

  if (!result.ok) {
    console.error(
      `Brevo send failed: ${result.error ?? "unknown"} (status ${result.status ?? "n/a"})`,
    );
    return json({
      ok: false,
      sent: 0,
      to: toList.length,
      cc: filteredCc.length,
      error: result.error ?? "unknown",
    });
  }

  return json({
    ok: true,
    sent: 1,
    to: toList.length,
    cc: filteredCc.length,
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
  <p>Hello,</p>
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
