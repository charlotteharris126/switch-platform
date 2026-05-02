// Edge Function: crm-webhook-receiver
//
// Receives status updates from a provider's CRM (HubSpot Workflow webhook,
// Pipedrive, custom integration, etc.) and applies them to crm.enrolments.
// Provider-side equivalent of the sheet-edit-mirror Channel A flow — same
// audit trail in crm.sheet_edits_log so updates show up on the
// /admin/sheet-activity page alongside sheet edits.
//
// URL shape (one URL per provider):
//   https://<project>.supabase.co/functions/v1/crm-webhook-receiver?token=<crm_webhook_token>
//
// Auth: ?token=<value> matched against crm.providers.crm_webhook_token.
// Deploy with --no-verify-jwt; verify_jwt=false in config.toml.
//
// Body — one of these shapes (we accept several to keep provider config simple):
//
//   { "lead_id": "SL-26-04-0163", "status": "enrolled" }
//   { "email": "learner@example.com", "status": "contacted" }
//   { "objectId": 12345, "properties": { "email": "...", "lifecyclestage": "customer" } }   // HubSpot Workflows native
//
// Status mapping accepts our enum values directly + a generous alias list
// for common HubSpot lifecycle stages (subscriber, MQL, SQL, opportunity,
// customer, evangelist).
//
// Always returns 200 to the provider's CRM (it doesn't retry; persistent
// failures land in leads.dead_letter inside the function).

import postgres from "npm:postgres@3";
import { sendBrevoEmail } from "../_shared/brevo.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
const OWNER_NOTIFICATION_EMAIL =
  Deno.env.get("OWNER_NOTIFICATION_EMAIL") ?? "charlotte@switchleads.co.uk";

if (!DATABASE_URL) throw new Error("SUPABASE_DB_URL is not set.");

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

// Status mapping — accepts our enum values directly and common provider/CRM
// vocabulary. Anything unmapped → anomaly path.
const STATUS_MAP: Record<string, string> = {
  // Our enum
  open: "open",
  contacted: "contacted",
  enrolled: "enrolled",
  presumed_enrolled: "presumed_enrolled",
  cannot_reach: "cannot_reach",
  not_enrolled: "not_enrolled",
  lost: "lost",
  disputed: "disputed",
  // Sheet vocabulary (case-insensitive)
  "presumed enrolled": "presumed_enrolled",
  "cannot reach": "cannot_reach",
  "not enrolled": "not_enrolled",
  // HubSpot lifecycle stages
  subscriber: "open",
  lead: "open",
  marketingqualifiedlead: "contacted",
  mql: "contacted",
  salesqualifiedlead: "contacted",
  sql: "contacted",
  opportunity: "contacted",
  customer: "enrolled",
  evangelist: "enrolled",
  other: "open",
};

function isAllowedTransition(current: string, target: string): boolean {
  if (current === "billed" || current === "paid") return false;
  if (target === "billed" || target === "paid") return false;
  if (target === "open") return false;
  return true;
}

interface NormalisedPayload {
  leadId: number | null;
  email: string | null;
  rawStatus: string | null;
}

function parseLeadIdValue(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
  const m = s.match(/(\d+)\s*$/);
  return m ? Number.parseInt(m[1], 10) : null;
}

function normalisePayload(body: unknown): NormalisedPayload {
  if (!body || typeof body !== "object") {
    return { leadId: null, email: null, rawStatus: null };
  }
  const o = body as Record<string, unknown>;
  // HubSpot Workflows native shape: { objectId, properties: { email, lifecyclestage } }
  const props = (o.properties && typeof o.properties === "object") ? o.properties as Record<string, unknown> : {};

  const leadId =
    parseLeadIdValue(o.lead_id) ??
    parseLeadIdValue(props.lead_id) ??
    parseLeadIdValue(o.switchleads_lead_id) ??
    parseLeadIdValue(props.switchleads_lead_id);

  const emailRaw = o.email ?? props.email ?? null;
  const email = typeof emailRaw === "string" ? emailRaw.toLowerCase().trim() : null;

  const statusRaw =
    o.status ??
    props.status ??
    o.lifecyclestage ??
    props.lifecyclestage ??
    o.stage ??
    props.stage ??
    null;
  const rawStatus = typeof statusRaw === "string" ? statusRaw : null;

  return { leadId, email, rawStatus };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Auth: token in query string
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  if (!token) return json({ ok: false, error: "missing token" }, 401);

  const providerRows = await sql<Array<{ provider_id: string; company_name: string }>>`
    SELECT provider_id, company_name FROM crm.providers WHERE crm_webhook_token = ${token} LIMIT 1
  `;
  const provider = providerRows[0];
  if (!provider) return json({ ok: false, error: "invalid token" }, 401);

  // Parse body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const { leadId, email, rawStatus } = normalisePayload(body);

  if (!leadId && !email) {
    return await rejectAndLog(provider.provider_id, body, "no lead_id or email in payload");
  }
  if (!rawStatus) {
    return await rejectAndLog(provider.provider_id, body, "no status / lifecyclestage in payload");
  }

  // Resolve enrolment row by lead_id first, falling back to email lookup
  let enrolment: { id: number; submission_id: number; status: string } | null = null;
  if (leadId) {
    const rows = await sql<Array<{ id: number; submission_id: number; status: string }>>`
      SELECT id, submission_id, status
      FROM crm.enrolments
      WHERE submission_id = ${leadId} AND provider_id = ${provider.provider_id}
      ORDER BY id DESC LIMIT 1
    `;
    enrolment = rows[0] ?? null;
  }
  if (!enrolment && email) {
    const rows = await sql<Array<{ id: number; submission_id: number; status: string }>>`
      SELECT e.id, e.submission_id, e.status
      FROM crm.enrolments e
      JOIN leads.submissions s ON s.id = e.submission_id
      WHERE lower(s.email) = ${email} AND e.provider_id = ${provider.provider_id}
      ORDER BY e.id DESC LIMIT 1
    `;
    enrolment = rows[0] ?? null;
  }

  if (!enrolment) {
    return await rejectAndLog(
      provider.provider_id,
      body,
      `no enrolment found for ${leadId ? `lead ${leadId}` : `email ${email}`}`,
      { submissionId: leadId },
    );
  }

  // Map status
  const normalised = rawStatus.trim().toLowerCase();
  const dbStatus = STATUS_MAP[normalised];
  if (!dbStatus) {
    await logEdit({
      providerId: provider.provider_id,
      submissionId: enrolment.submission_id,
      enrolmentId: enrolment.id,
      newValue: rawStatus,
      oldValue: enrolment.status,
      action: "queued",
      reason: `unmapped status value from CRM: "${rawStatus}"`,
    });
    await safeSendAnomalyEmail(provider.company_name, enrolment.submission_id, rawStatus, "Status value not recognised");
    return json({ ok: false, action: "queued", reason: "unmapped status" }, 200);
  }

  // No-op?
  if (dbStatus === enrolment.status) {
    await logEdit({
      providerId: provider.provider_id,
      submissionId: enrolment.submission_id,
      enrolmentId: enrolment.id,
      newValue: rawStatus,
      oldValue: enrolment.status,
      action: "mirrored",
      appliedStatus: dbStatus,
      reason: "no-op (already at this status)",
    });
    return json({ ok: true, action: "mirrored", noop: true }, 200);
  }

  if (!isAllowedTransition(enrolment.status, dbStatus)) {
    await logEdit({
      providerId: provider.provider_id,
      submissionId: enrolment.submission_id,
      enrolmentId: enrolment.id,
      newValue: rawStatus,
      oldValue: enrolment.status,
      action: "queued",
      reason: `invalid transition: ${enrolment.status} → ${dbStatus}`,
    });
    await safeSendAnomalyEmail(provider.company_name, enrolment.submission_id, rawStatus, `Invalid transition: ${enrolment.status} → ${dbStatus}`);
    return json({ ok: false, action: "queued", reason: "invalid transition" }, 200);
  }

  // Apply
  await sql`
    UPDATE crm.enrolments
    SET status = ${dbStatus}, status_updated_at = now(), updated_at = now()
    WHERE id = ${enrolment.id}
  `;
  if (dbStatus === "disputed") {
    await sql`
      INSERT INTO crm.disputes (enrolment_id, raised_by, reason)
      VALUES (${enrolment.id}, 'provider', ${`CRM webhook: status set to disputed (raw: "${rawStatus}")`})
    `;
  }

  await logEdit({
    providerId: provider.provider_id,
    submissionId: enrolment.submission_id,
    enrolmentId: enrolment.id,
    newValue: rawStatus,
    oldValue: enrolment.status,
    action: "mirrored",
    appliedStatus: dbStatus,
  });

  return json({ ok: true, action: "mirrored", applied_status: dbStatus }, 200);
});

// ---- Helpers ----

async function rejectAndLog(
  providerId: string,
  body: unknown,
  reason: string,
  opts: { submissionId?: number | null } = {},
): Promise<Response> {
  await logEdit({
    providerId,
    submissionId: opts.submissionId ?? null,
    enrolmentId: null,
    newValue: typeof body === "object" ? JSON.stringify(body).slice(0, 500) : String(body).slice(0, 500),
    oldValue: null,
    action: "rejected",
    reason,
  });
  await safeSendAnomalyEmail(providerId, opts.submissionId ?? null, "(see audit log)", reason);
  return json({ ok: false, action: "rejected", reason }, 200);
}

async function logEdit(args: {
  providerId: string;
  submissionId: number | null;
  enrolmentId: number | null;
  newValue: string | null;
  oldValue: string | null;
  action: string;
  appliedStatus?: string | null;
  reason?: string | null;
}): Promise<void> {
  try {
    await sql`
      INSERT INTO crm.sheet_edits_log (
        enrolment_id, submission_id, provider_id, column_name,
        old_value, new_value, editor_email, edited_at,
        action, applied_status, reason
      ) VALUES (
        ${args.enrolmentId}, ${args.submissionId}, ${args.providerId}, 'CRM',
        ${args.oldValue}, ${args.newValue}, 'crm_webhook', now(),
        ${args.action}, ${args.appliedStatus ?? null}, ${args.reason ?? null}
      )
    `;
  } catch (err) {
    console.error("crm webhook log failed:", String(err));
  }
}

async function safeSendAnomalyEmail(providerLabel: string, submissionId: number | null, value: string, reason: string): Promise<void> {
  try {
    const html = `
      <p>CRM webhook anomaly — needs a look.</p>
      <ul>
        <li><strong>Provider:</strong> ${escapeHtml(providerLabel)}</li>
        <li><strong>Lead:</strong> ${submissionId ? `#${submissionId}` : "(not resolved)"}</li>
        <li><strong>Status sent:</strong> ${escapeHtml(value)}</li>
        <li><strong>Reason:</strong> ${escapeHtml(reason)}</li>
      </ul>
      <p>Logged in <code>crm.sheet_edits_log</code>. Open admin → Sheet activity to inspect.</p>
    `;
    await sendBrevoEmail({
      brand: "switchleads",
      to: [{ email: OWNER_NOTIFICATION_EMAIL }],
      subject: `[CRM webhook anomaly] ${providerLabel}: ${reason.slice(0, 60)}`,
      htmlContent: html,
    });
  } catch (err) {
    console.error("anomaly email failed:", String(err));
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
