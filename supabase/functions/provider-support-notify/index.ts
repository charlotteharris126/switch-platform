// Edge Function: provider-support-notify
//
// Fired by the provider Support form submission. Looks up a
// crm.support_requests row by id, composes an email to
// support@switchleads.co.uk with the form contents + provider context,
// sends via the existing Brevo helper, and marks email_sent_at on the
// row when the dispatch succeeds.
//
// Auth: x-audit-key header matched against vault.AUDIT_SHARED_SECRET.
//
// Body: { "request_id": <bigint> }
//
// Response: { ok: true } | { ok: false, error: "..." }

import postgres from "npm:postgres@3";
import { sendBrevoEmail } from "../_shared/brevo.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) throw new Error("SUPABASE_DB_URL not set");
const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 20, prepare: false });

const SUPPORT_INBOX = "support@switchleads.co.uk";

const CATEGORY_LABEL: Record<string, string> = {
  lead_query: "Lead query",
  billing: "Billing",
  technical: "Technical issue",
  account: "Account / login",
  other: "Other",
};

async function getAuditSharedSecret(): Promise<string> {
  const rows = await sql<Array<{ secret: string }>>`
    SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
  `;
  const secret = rows[0]?.secret;
  if (!secret) throw new Error("AUDIT_SHARED_SECRET not in vault");
  return secret;
}

interface RequestRow {
  id: number;
  provider_id: string;
  submitter_email: string;
  submitter_name: string | null;
  category: string;
  subject: string;
  message: string;
  created_at: string;
  company_name: string;
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

  let body: { request_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const requestId = typeof body.request_id === "number" ? body.request_id : null;
  if (!requestId) return json({ error: "request_id required" }, 400);

  let row: RequestRow | undefined;
  try {
    [row] = await sql<RequestRow[]>`
      SELECT sr.id, sr.provider_id, sr.submitter_email, sr.submitter_name,
             sr.category, sr.subject, sr.message, sr.created_at,
             p.company_name
        FROM crm.support_requests sr
        JOIN crm.providers p ON p.provider_id = sr.provider_id
       WHERE sr.id = ${requestId}
    `;
  } catch (err) {
    return json({ error: `lookup failed: ${String(err)}` }, 500);
  }
  if (!row) return json({ error: "request not found" }, 404);

  const categoryLabel = CATEGORY_LABEL[row.category] ?? row.category;
  const subject = `[Support] ${row.company_name}. ${row.subject}`;
  const portalLink = `https://app.switchleads.co.uk/admin/leads/`;
  const html = composeHtml({
    requestId: row.id,
    company: row.company_name,
    submitterName: row.submitter_name,
    submitterEmail: row.submitter_email,
    category: categoryLabel,
    subjectLine: row.subject,
    message: row.message,
    createdAt: row.created_at,
    adminUrl: portalLink,
  });

  const result = await sendBrevoEmail({
    brand: "switchleads",
    to: [{ email: SUPPORT_INBOX, name: "SwitchLeads Support" }],
    replyTo: { email: row.submitter_email, name: row.submitter_name ?? row.submitter_email },
    subject,
    htmlContent: html,
    tags: ["provider-support-request"],
  });

  if (!result.ok) {
    console.error(`Brevo support send failed for request ${row.id}: ${result.error}`);
    return json({ ok: false, error: result.error ?? "Brevo send failed" }, 500);
  }

  // Mark as dispatched so we don't double-send if the form is retried.
  try {
    await sql`
      UPDATE crm.support_requests
         SET email_sent_at = now()
       WHERE id = ${row.id}
    `;
  } catch (err) {
    console.error(`mark email_sent_at failed for ${row.id}: ${String(err)}`);
    // Email did send; just couldn't mark the row. Surface but don't fail.
    return json({ ok: true, warning: "email sent but row update failed" });
  }

  return json({ ok: true });
});

function composeHtml(args: {
  requestId: number;
  company: string;
  submitterName: string | null;
  submitterEmail: string;
  category: string;
  subjectLine: string;
  message: string;
  createdAt: string;
  adminUrl: string;
}): string {
  const escapedMessage = escapeHtml(args.message).replace(/\n/g, "<br>");
  const submittedAt = new Date(args.createdAt).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const fromLine = args.submitterName
    ? `${escapeHtml(args.submitterName)} (${escapeHtml(args.submitterEmail)})`
    : escapeHtml(args.submitterEmail);

  return `
<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0f172a; line-height: 1.5; padding: 16px; max-width: 640px;">
  <p style="font-size: 18px; font-weight: 600; margin: 0 0 4px 0;">
    Support request. ${escapeHtml(args.company)}
  </p>
  <p style="margin: 0 0 16px 0; color: #64748b; font-size: 13px;">
    Request #${args.requestId} · ${submittedAt}
  </p>

  <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
    <tr>
      <td style="padding: 6px 0; width: 120px; color: #64748b; font-size: 13px;">From</td>
      <td style="padding: 6px 0; font-size: 13px;">${fromLine}</td>
    </tr>
    <tr>
      <td style="padding: 6px 0; color: #64748b; font-size: 13px;">Category</td>
      <td style="padding: 6px 0; font-size: 13px;">${escapeHtml(args.category)}</td>
    </tr>
    <tr>
      <td style="padding: 6px 0; color: #64748b; font-size: 13px;">Subject</td>
      <td style="padding: 6px 0; font-size: 13px; font-weight: 600;">${escapeHtml(args.subjectLine)}</td>
    </tr>
  </table>

  <div style="padding: 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 16px;">
    <p style="margin: 0; white-space: pre-wrap;">${escapedMessage}</p>
  </div>

  <p style="margin: 16px 0 0 0; font-size: 12px; color: #64748b;">
    Reply directly to this email to respond. it goes back to ${escapeHtml(args.submitterEmail)}.
  </p>
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
