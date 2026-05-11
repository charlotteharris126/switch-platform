// Edge Function: republish-provider-sheet
//
// On-demand DB → sheet republish for a single provider. For every lead
// routed to that provider, calls the appender's `update_by_submission_id`
// mode with the DB's current state for that row (status, lost_reason,
// fastracked flag, fastrack_notes). Makes the DB authoritative by force
// whenever the operator suspects drift.
//
// Use case: lead #375 hit a DB-vs-sheet divergence
// (https://github.com/.../commit/2fd8a12 fixes the forward path so this
// class can't recur, but pre-existing drift needs a recovery path). This
// function is the recovery path.
//
// Trigger: admin Server Action from /admin/providers/[id] (button +
// confirm). Not a cron — daily reconcile with proactive drift detection
// is a follow-up (needs a "read all rows" mode on the Apps Script
// appender, which currently only supports append + update).
//
// Auth: x-audit-key matched against AUDIT_SHARED_SECRET in vault.
// Body: { "provider_id": "<id>", "apply": boolean }
//
// Response:
//   {
//     ok: true,
//     mode: "dry_run" | "apply",
//     provider_id: "...",
//     leads_total: 47,
//     leads_written: 42,
//     leads_skipped_no_appender_ack: 0,
//     errors: 0,
//     error_messages: [...],
//     spot_checks: [{ submission_id, status_db, lost_reason_db, fastracked }, ...]
//   }
//
// Per-row latency: ~250ms (Apps Script webhook). 100 routed leads ~25s,
// 500 routed leads ~125s. Server Action will time out on Netlify (~26s)
// for big providers; in that case the operator re-runs to mop up (the
// function is idempotent — same row state in → same row state out).

import postgres from "npm:postgres@3";
import { lostReasonHumanText, statusToSheetLabel } from "../_shared/sheet-status.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) throw new Error("SUPABASE_DB_URL not set");
const SHEETS_APPEND_TOKEN = Deno.env.get("SHEETS_APPEND_TOKEN");
if (!SHEETS_APPEND_TOKEN) throw new Error("SHEETS_APPEND_TOKEN not set");

const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 20, prepare: false });

const INTER_WRITE_DELAY_MS = 100;

interface RoutedLead {
  submission_id: number;
  status: string;
  lost_reason: string | null;
  fastracked_at: string | null;
}

interface SpotCheck {
  submission_id: number;
  status_db: string;
  lost_reason_db: string | null;
  fastracked: boolean;
}

interface RunSummary {
  mode: "dry_run" | "apply";
  provider_id: string;
  company_name: string | null;
  leads_total: number;
  leads_written: number;
  leads_skipped_no_appender_ack: number;
  errors: number;
  error_messages: string[];
  spot_checks: SpotCheck[];
}

async function getAuditSharedSecret(): Promise<string> {
  const rows = await sql<Array<{ secret: string }>>`
    SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
  `;
  const secret = rows[0]?.secret;
  if (!secret) throw new Error("AUDIT_SHARED_SECRET not in vault");
  return secret;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function run(providerId: string, apply: boolean): Promise<RunSummary> {
  // 1. Load provider + sheet webhook
  const providerRows = await sql<Array<{
    sheet_webhook_url: string | null;
    company_name: string;
  }>>`
    SELECT sheet_webhook_url, company_name
      FROM crm.providers
     WHERE provider_id = ${providerId}
     LIMIT 1
  `;
  const provider = providerRows[0];
  if (!provider) {
    throw new Error(`provider not found: ${providerId}`);
  }
  if (!provider.sheet_webhook_url) {
    throw new Error(`provider ${providerId} has no sheet_webhook_url configured`);
  }

  // 2. Load every routed lead for this provider with current DB state
  const leads = await sql<RoutedLead[]>`
    SELECT s.id AS submission_id,
           COALESCE(e.status, 'open') AS status,
           e.lost_reason,
           s.fastracked_at
      FROM leads.submissions s
 LEFT JOIN crm.enrolments e ON e.submission_id = s.id
     WHERE s.primary_routed_to = ${providerId}
       AND s.is_dq IS NOT TRUE
  `;

  const spotChecks: SpotCheck[] = leads.slice(0, 3).map((l) => ({
    submission_id: l.submission_id,
    status_db: l.status,
    lost_reason_db: l.lost_reason,
    fastracked: l.fastracked_at != null,
  }));

  if (!apply) {
    return {
      mode: "dry_run",
      provider_id: providerId,
      company_name: provider.company_name,
      leads_total: leads.length,
      leads_written: 0,
      leads_skipped_no_appender_ack: 0,
      errors: 0,
      error_messages: [],
      spot_checks: spotChecks,
    };
  }

  // 3. For each lead, call the appender with the DB's state
  let written = 0;
  let skippedNoAck = 0;
  let errors = 0;
  const errorMessages: string[] = [];

  for (const lead of leads) {
    const payload: Record<string, unknown> = {
      token: SHEETS_APPEND_TOKEN,
      mode: "update_by_submission_id",
      submission_id: lead.submission_id,
      status: statusToSheetLabel(lead.status),
    };
    if (lead.status === "lost" && lead.lost_reason) {
      payload.lost_reason = lostReasonHumanText(lead.lost_reason);
    }
    if (lead.fastracked_at) {
      payload.fastracked = "yes";
    }

    try {
      const res = await fetch(provider.sheet_webhook_url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        errors++;
        errorMessages.push(
          `submission_id=${lead.submission_id}: appender HTTP ${res.status}`,
        );
      } else {
        const respBody = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          updates?: number;
          error?: string;
        };
        if (respBody.ok === false) {
          errors++;
          errorMessages.push(
            `submission_id=${lead.submission_id}: appender ok=false: ${respBody.error ?? "unknown"}`,
          );
        } else if (typeof respBody.updates === "number" && respBody.updates === 0) {
          // ok but no rows changed — sheet doesn't have the submission_id
          // (lead never landed in sheet) or sheet missing headers
          skippedNoAck++;
        } else {
          written++;
        }
      }
    } catch (err) {
      errors++;
      errorMessages.push(
        `submission_id=${lead.submission_id}: fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await sleep(INTER_WRITE_DELAY_MS);
  }

  // 4. Refresh spot-checks with post-write DB state (in case anything raced)
  if (leads.length > 0) {
    const spotIds = spotChecks.map((s) => s.submission_id);
    const fresh = await sql<RoutedLead[]>`
      SELECT s.id AS submission_id,
             COALESCE(e.status, 'open') AS status,
             e.lost_reason,
             s.fastracked_at
        FROM leads.submissions s
   LEFT JOIN crm.enrolments e ON e.submission_id = s.id
       WHERE s.id = ANY(${spotIds})
    `;
    const byId = new Map(fresh.map((f) => [f.submission_id, f]));
    for (const sc of spotChecks) {
      const f = byId.get(sc.submission_id);
      if (f) {
        sc.status_db = f.status;
        sc.lost_reason_db = f.lost_reason;
        sc.fastracked = f.fastracked_at != null;
      }
    }
  }

  return {
    mode: "apply",
    provider_id: providerId,
    company_name: provider.company_name,
    leads_total: leads.length,
    leads_written: written,
    leads_skipped_no_appender_ack: skippedNoAck,
    errors,
    error_messages: errorMessages,
    spot_checks: spotChecks,
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let expected: string;
  try {
    expected = await getAuditSharedSecret();
  } catch (err) {
    console.error("vault secret fetch failed:", String(err));
    return json({ ok: false, error: "AUDIT_SHARED_SECRET not retrievable from vault" }, 500);
  }
  const provided = req.headers.get("x-audit-key");
  if (!provided || provided !== expected) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let body: { provider_id?: unknown; apply?: unknown };
  try {
    body = await req.json() as { provider_id?: unknown; apply?: unknown };
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const providerId = typeof body.provider_id === "string" ? body.provider_id : null;
  if (!providerId) {
    return json({ ok: false, error: "provider_id required" }, 400);
  }
  const apply = body.apply === true;

  try {
    const summary = await run(providerId, apply);
    return json({ ok: true, ...summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("republish failed:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});
