// Edge Function: backfill-sw-provider-contact-block
//
// One-shot backfill for the SW_PROVIDER_CONTACT_BLOCK contact attribute on
// existing Switchable Brevo contacts. Written 2026-05-16 (Session 48) after
// the param→attribute switch — existing contacts don't carry the attribute
// yet, and Wren needs them populated so Brevo template preview resolves
// the value for QA against existing test contacts.
//
// Chunked + auto-chained to stay clear of the Edge Function compute budget:
// each invocation processes CHUNK_SIZE submissions, then fires itself with
// the next offset via EdgeRuntime.waitUntil before returning. Charlotte
// fires one curl with no offset; the worker chain handles the rest.
//
// Self-selects audience (no submissionIds input). Idempotent: re-running
// a chunk reapplies the same upsert against the same Brevo contact.
//
// Auth: x-audit-key header against AUDIT_SHARED_SECRET in vault. The
// audit key is forwarded to the chained continuation call.
//
// Triggered by: manual POST. No cron, no body required.
//
// Query params (optional):
//   offset  — starting submission index (default 0)
//
// Response shape:
//   {
//     ok: true,
//     chunk: { offset, processed, ok_count, skipped_count, error_count },
//     total, next_offset, has_more,
//     sample_errors: string[]
//   }

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

// Chunk size: small enough to stay clear of compute budget per invocation.
// 20 contacts × ~15ms CPU per upsert ≈ 300ms CPU, well inside the worker
// budget. Each chunk runs in a fresh isolate via the chained fetch below.
const CHUNK_SIZE = 20;

// Throttle between Brevo calls inside one chunk to stay clear of contacts-API
// rate limit (same posture as admin-brevo-resync).
const THROTTLE_MS = 250;

async function getAuditSharedSecret(): Promise<string> {
  const rows = await sql<Array<{ secret: string }>>`
    SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
  `;
  const secret = rows[0]?.secret;
  if (!secret) throw new Error("AUDIT_SHARED_SECRET not in vault");
  return secret;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const url = new URL(req.url);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);

  const rows = await sql<Array<{ id: number }>>`
    SELECT id
      FROM leads.submissions
     WHERE archived_at IS NULL
       AND email IS NOT NULL
     ORDER BY id
  `;
  const allIds = rows.map((r) => Number(r.id));
  const total = allIds.length;
  const chunkIds = allIds.slice(offset, offset + CHUNK_SIZE);

  console.log(`backfill chunk offset=${offset} size=${chunkIds.length} total=${total}`);

  let okCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const sampleErrors: string[] = [];

  for (let i = 0; i < chunkIds.length; i++) {
    if (i > 0) await sleep(THROTTLE_MS);
    const result = await resyncOne(chunkIds[i]);
    if (result.status === "ok") okCount++;
    else if (result.status === "skipped") skippedCount++;
    else {
      errorCount++;
      if (sampleErrors.length < 10) {
        sampleErrors.push(`id=${result.id}: ${result.reason ?? "unknown"}`);
      }
    }
  }

  const nextOffset = offset + chunkIds.length;
  const hasMore = nextOffset < total;

  // No auto-chain. Each invocation processes one chunk and returns.
  // Caller (scripts/run-039-backfill.sh) loops over offsets — each chunk
  // gets its own fresh compute budget, and a re-run is idempotent.

  return json({
    ok: true,
    chunk: {
      offset,
      processed: chunkIds.length,
      ok_count: okCount,
      skipped_count: skippedCount,
      error_count: errorCount,
    },
    total,
    next_offset: nextOffset,
    has_more: hasMore,
    sample_errors: sampleErrors,
  }, 200);
});

interface ResyncResult {
  id: number;
  status: "ok" | "skipped" | "error";
  reason?: string;
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
             is_dq, dq_reason, primary_routed_to, archived_at,
             marketing_opt_in,
             preferred_intake_id, acceptable_intake_ids,
             referral_code, client_nonce,
             start_timing, interest_breadth, investment_willingness,
             current_qualification, source_form, enriched_at,
             fastracked_at
        FROM leads.submissions
       WHERE id = ${submissionId}
    `;
    if (!submissionRow) return { id: submissionId, status: "skipped", reason: "submission not found" };
    if (submissionRow.archived_at) return { id: submissionId, status: "skipped", reason: "archived" };

    if (submissionRow.is_dq) {
      try {
        const r = await upsertLearnerInBrevoNoMatch(sql, submissionId, "no_match");
        if (!r.ok) return { id: submissionId, status: "error", reason: `no_match upsert: ${r.error ?? "unknown"}` };
        return { id: submissionId, status: "ok", reason: "dq → no_match" };
      } catch (err) {
        return { id: submissionId, status: "error", reason: `no_match upsert: ${String(err)}` };
      }
    }

    if (!submissionRow.primary_routed_to) {
      try {
        const r = await upsertLearnerInBrevoNoMatch(sql, submissionId, "pending");
        if (!r.ok) return { id: submissionId, status: "error", reason: `pending upsert: ${r.error ?? "unknown"}` };
        return { id: submissionId, status: "ok", reason: "unrouted → pending" };
      } catch (err) {
        return { id: submissionId, status: "error", reason: `pending upsert: ${String(err)}` };
      }
    }

    submission = submissionRow;

    const [providerRow] = await sql<ProviderRow[]>`
      SELECT provider_id, company_name, contact_email, contact_name,
             sheet_id, sheet_webhook_url, cc_emails,
             active, archived_at, auto_route_enabled,
             trust_line, regions, regional_contacts
        FROM crm.providers
       WHERE provider_id = ${submissionRow.primary_routed_to}
    `;
    if (!providerRow) return { id: submissionId, status: "error", reason: "provider not found" };
    if (!providerRow.active || providerRow.archived_at) {
      return { id: submissionId, status: "error", reason: "provider inactive/archived" };
    }
    provider = providerRow;
  } catch (err) {
    return { id: submissionId, status: "error", reason: `db read: ${String(err)}` };
  }

  try {
    const r = await upsertLearnerInBrevo(sql, provider, submission);
    if (!r.ok) return { id: submissionId, status: "error", reason: `upsert: ${r.error ?? "unknown"}` };
    return { id: submissionId, status: "ok" };
  } catch (err) {
    return { id: submissionId, status: "error", reason: `upsert: ${String(err)}` };
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
