// Edge Function: admin-brevo-resync
//
// Re-fires the Switchable learner Brevo upsert for an arbitrary list of
// already-routed submissions. Use when a Brevo attribute composition change
// or matrix.json shape change has shipped and existing contacts still hold
// stale attributes from prior runs. Brevo's contact API is idempotent on
// email so this is safe to invoke against the same id repeatedly.
//
// What it does NOT do:
//   - Does not touch leads.routing_log or leads.submissions.primary_routed_to.
//     Routing is already committed by the time this runs; we're refreshing
//     the downstream Brevo side-effect only.
//   - Does not write audit.actions rows. Brevo state is external; our audit
//     covers DB writes. If audit coverage of resync events becomes valuable
//     (volume + frequency), add an audit.log_action call here.
//
// Auth: same AUDIT_SHARED_SECRET / x-audit-key header pattern as
// netlify-leads-reconcile and netlify-forms-audit.
//
// Triggered by: manual POST only. No cron.
//
// Body shape:
//   { "submissionIds": [206, 207, ...] }
//
// Response shape:
//   { "results": [{ "id": 206, "status": "ok" | "skipped" | "error", "reason"?: string }] }
//
// Skip reasons:
//   - submission not found
//   - submission has primary_routed_to = NULL (never routed; nothing to resync)
//   - submission is_dq (Brevo upsert deliberately skipped for DQ leads)
//   - submission archived_at IS NOT NULL (intentionally excluded from active flows)
//   - provider not found / inactive (data integrity issue, surface as error)

import postgres from "npm:postgres@3";
import {
  type ProviderRow,
  type SubmissionRow,
  upsertLearnerInBrevo,
  upsertLearnerInBrevoNoMatch,
} from "../_shared/route-lead.ts";

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

interface ResyncResult {
  id: number;
  status: "ok" | "skipped" | "error";
  reason?: string;
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
  if (providedKey !== expectedKey) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: { submissionIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const ids = Array.isArray(body.submissionIds) ? body.submissionIds : null;
  if (!ids || ids.length === 0) {
    return json({ error: "submissionIds must be a non-empty array of numbers" }, 400);
  }
  const numericIds = ids.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (numericIds.length !== ids.length) {
    return json({ error: "submissionIds must contain only numbers" }, 400);
  }

  // Throttle between Brevo calls so we stay below the contacts-API rate limit
  // (observed 429s firing 6 parallel batches of 25 with no delay; 250ms gap
  // gives ~4 calls/sec per running instance, well clear of the limit).
  const THROTTLE_MS = 250;

  const results: ResyncResult[] = [];
  for (let i = 0; i < numericIds.length; i++) {
    if (i > 0) await sleep(THROTTLE_MS);
    results.push(await resyncOne(numericIds[i]));
  }

  return json({ results }, 200);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resyncOne(submissionId: number): Promise<ResyncResult> {
  let submission: SubmissionRow;
  let provider: ProviderRow;

  try {
    const [submissionRow] = await sql<SubmissionRow[]>`
      SELECT id, submitted_at, course_id, funding_category, funding_route,
             first_name, last_name, email, phone,
             la, region_scheme, age_band, employment_status,
             prior_level_3_or_higher, can_start_on_intake_date,
             outcome_interest, why_this_course,
             postcode, region, reason, interest, situation,
             qualification, start_when, budget, courses_selected,
             is_dq, primary_routed_to, archived_at,
             marketing_opt_in,
             preferred_intake_id, acceptable_intake_ids
        FROM leads.submissions
       WHERE id = ${submissionId}
    `;
    if (!submissionRow) return { id: submissionId, status: "skipped", reason: "submission not found" };
    if (submissionRow.archived_at) return { id: submissionId, status: "skipped", reason: "archived" };

    // DQ leads: push as no_match with SW_DQ_REASON populated. Pre-2026-04-30
    // these leads were never in Brevo at all; the no-match build added them
    // to the U-track utility list for SF8 recirc + monthly newsletter.
    if (submissionRow.is_dq) {
      try {
        const r = await upsertLearnerInBrevoNoMatch(sql, submissionId, "no_match");
        if (!r.ok) return { id: submissionId, status: "error", reason: `no_match upsert: ${r.error ?? "unknown"}` };
        return { id: submissionId, status: "ok", reason: "dq → no_match" };
      } catch (err) {
        console.error(`resync ${submissionId} no_match upsert failed:`, err);
        return { id: submissionId, status: "error", reason: `no_match upsert: ${String(err)}` };
      }
    }

    // Unrouted qualified: push as pending (owner-confirm path will flip to
    // matched later). Currently zero such leads in production but the branch
    // future-proofs the resync against any that land before/after deploy.
    if (!submissionRow.primary_routed_to) {
      try {
        const r = await upsertLearnerInBrevoNoMatch(sql, submissionId, "pending");
        if (!r.ok) return { id: submissionId, status: "error", reason: `pending upsert: ${r.error ?? "unknown"}` };
        return { id: submissionId, status: "ok", reason: "unrouted → pending" };
      } catch (err) {
        console.error(`resync ${submissionId} pending upsert failed:`, err);
        return { id: submissionId, status: "error", reason: `pending upsert: ${String(err)}` };
      }
    }

    submission = submissionRow;

    const [providerRow] = await sql<ProviderRow[]>`
      SELECT provider_id, company_name, contact_email, contact_name,
             sheet_id, sheet_webhook_url, cc_emails,
             active, archived_at, auto_route_enabled,
             trust_line, regions
        FROM crm.providers
       WHERE provider_id = ${submissionRow.primary_routed_to}
    `;
    if (!providerRow) return { id: submissionId, status: "error", reason: "provider not found" };
    if (!providerRow.active || providerRow.archived_at) {
      return { id: submissionId, status: "error", reason: "provider inactive/archived" };
    }
    provider = providerRow;
  } catch (err) {
    console.error(`resync ${submissionId} read failed:`, err);
    return { id: submissionId, status: "error", reason: `db read: ${String(err)}` };
  }

  try {
    const r = await upsertLearnerInBrevo(sql, provider, submission);
    if (!r.ok) return { id: submissionId, status: "error", reason: `upsert: ${r.error ?? "unknown"}` };
    return { id: submissionId, status: "ok" };
  } catch (err) {
    console.error(`resync ${submissionId} upsert failed:`, err);
    return { id: submissionId, status: "error", reason: `upsert: ${String(err)}` };
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
