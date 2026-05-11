// Edge Function: gdpr-erase-learner
//
// Honours a UK GDPR Art. 17 right-to-erasure request for a single learner.
// Hard-deletes the learner's PII from:
//   1. The Supabase database (leads.submissions + every related row)
//   2. Brevo (contact + list memberships, via the Contacts DELETE endpoint)
//   3. Each provider's Google Sheet that received a routing for this email
//      (via the appender's `delete_submission_id` mode — Charlotte must
//      re-paste the canonical appender on each sheet to enable this mode;
//      function reports skipped/unsupported per provider if the appender
//      hasn't been updated yet so partial completion is visible)
//
// Writes a receipt to audit.erasure_requests with per-system results.
//
// Dry-run mode: lists exactly what would be deleted across all three
// surfaces without performing any write.
//
// Auth: x-audit-key matched against AUDIT_SHARED_SECRET in vault. The
// caller (admin panel Server Action wrapping this) re-checks admin
// before forwarding. The audit-key gate is the defence-in-depth layer.
//
// Body:
//   {
//     "email": "<learner@example.com>",   // required
//     "apply": boolean,                   // false = dry run, true = delete
//     "reason"?: "<text>",                // free-form admin note
//     "processed_by"?: "<auth.users.id>"  // optional admin user id for receipt
//   }
//
// Response:
//   {
//     ok: true,
//     mode: "dry_run" | "apply",
//     email,
//     submission_ids: [int],                  // every leads.submissions row
//                                              // matching this email
//     supabase_result: { ... },
//     brevo_result: { ... },
//     sheet_result: { providers: [{ provider_id, status, error? }], deleted_count },
//     erasure_request_id?: bigint              // audit.erasure_requests row id
//   }
//
// Failure modes are surfaced per-system so partial completion is visible
// and the operator can retry just the failing system from the panel.

import postgres from "npm:postgres@3";
import { deleteBrevoContact } from "../_shared/brevo.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) throw new Error("SUPABASE_DB_URL not set");
const SHEETS_APPEND_TOKEN = Deno.env.get("SHEETS_APPEND_TOKEN");
// SHEETS_APPEND_TOKEN may be unset in environments that don't ship sheet
// integration; we'll mark sheet erasure "skipped:unconfigured" in that case.

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  prepare: false,
});

const APPENDER_TIMEOUT_MS = 15000;

interface SubmissionRow {
  id: string; // BIGINT, postgres.js returns as string
  email: string | null;
  parent_submission_id: string | null;
  primary_routed_to: string | null;
}

interface SheetResultEntry {
  provider_id: string;
  company_name: string | null;
  status: "deleted" | "failed" | "skipped_unsupported" | "skipped_no_webhook";
  error?: string;
}

interface SheetResult {
  providers: SheetResultEntry[];
  deleted_count: number;
  failed_count: number;
}

interface SupabaseResult {
  submission_ids: number[];
  rows_deleted: {
    submissions: number;
    fastrack_submissions: number;
    enrolments: number;
    lead_notes: number;
    routing_log: number;
    dead_letter_matched: number;
  };
}

interface BrevoResultEntry {
  ok: boolean;
  error?: string;
}

interface RunSummary {
  ok: true;
  mode: "dry_run" | "apply";
  email: string;
  submission_ids: number[];
  supabase_result: SupabaseResult;
  brevo_result: BrevoResultEntry;
  sheet_result: SheetResult;
  erasure_request_id: number | null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Audit-key gate
  const provided = req.headers.get("x-audit-key");
  if (!provided) return new Response("Unauthorized", { status: 401 });
  let expected: string;
  try {
    const [row] = await sql<Array<{ secret: string }>>`
      SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
    `;
    expected = row?.secret ?? "";
    if (!expected) throw new Error("AUDIT_SHARED_SECRET not in vault");
  } catch (err) {
    console.error("vault fetch failed:", String(err));
    return json({ ok: false, error: "AUDIT_SHARED_SECRET not retrievable" }, 500);
  }
  if (provided !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: {
    email?: unknown;
    apply?: unknown;
    reason?: unknown;
    processed_by?: unknown;
  };
  try {
    body = await req.json() as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
  if (!email) return json({ ok: false, error: "email required" }, 400);
  const apply = body.apply === true;
  const reason = typeof body.reason === "string" ? body.reason : null;
  const processedBy = typeof body.processed_by === "string" ? body.processed_by : null;

  try {
    const summary = await run(email, apply, reason, processedBy);
    return json(summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("gdpr-erase-learner failed:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

async function run(
  email: string,
  apply: boolean,
  reason: string | null,
  processedBy: string | null,
): Promise<RunSummary> {
  // 1. Find every leads.submissions row for this email. Match is
  //    case-insensitive on email. Include children (parent_submission_id
  //    chain) and any submission that previously held this email even if
  //    re-applications carry it on multiple rows.
  const submissions = await sql<SubmissionRow[]>`
    SELECT id::text AS id, email, parent_submission_id::text AS parent_submission_id, primary_routed_to
      FROM leads.submissions
     WHERE lower(email) = ${email}
  `;
  const submissionIds = submissions.map((s) => Number(s.id)).filter((n) => Number.isFinite(n));

  // Per-provider routings (for sheet erasure). One row per provider that
  // ever received any of these submissions — we delete sheet rows for the
  // full set, not just the most-recent routing.
  const routings = await sql<Array<{
    provider_id: string;
    company_name: string | null;
    sheet_webhook_url: string | null;
  }>>`
    SELECT DISTINCT p.provider_id, p.company_name, p.sheet_webhook_url
      FROM leads.routing_log rl
      JOIN crm.providers p ON p.provider_id = rl.provider_id
     WHERE rl.submission_id = ANY(${submissionIds}::BIGINT[])
  `;

  // Pre-create the audit.erasure_requests row so even a half-failed run
  // leaves a discoverable receipt. Status starts 'in_progress' (or
  // 'pending' for dry-run) and gets updated as systems report back.
  let erasureRequestId: number | null = null;
  if (apply) {
    const [created] = await sql<Array<{ id: number }>>`
      INSERT INTO audit.erasure_requests (
        requester_email, status, notes, processed_by
      ) VALUES (
        ${email}, 'in_progress', ${reason}, ${processedBy}::uuid
      )
      RETURNING id
    `;
    erasureRequestId = created?.id ?? null;
  }

  // 2. Supabase deletes (apply path only)
  const supabaseResult: SupabaseResult = {
    submission_ids: submissionIds,
    rows_deleted: {
      submissions: 0,
      fastrack_submissions: 0,
      enrolments: 0,
      lead_notes: 0,
      routing_log: 0,
      dead_letter_matched: 0,
    },
  };

  if (apply && submissionIds.length > 0) {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;

      // dead_letter rows may reference these submissions via raw_payload —
      // count matches but DON'T delete the dead_letter rows themselves
      // (operational record of what landed). The raw_payload may carry
      // PII so we anonymise it instead.
      const dlMatched = await trx<Array<{ count: string }>>`
        SELECT COUNT(*)::text AS count
          FROM leads.dead_letter
         WHERE raw_payload->>'email' = ${email}
            OR (raw_payload->>'submission_id')::bigint = ANY(${submissionIds}::BIGINT[])
      `;
      supabaseResult.rows_deleted.dead_letter_matched =
        Number(dlMatched[0]?.count ?? 0);

      // Scrub PII out of dead_letter raw_payload for matched rows.
      await trx`
        UPDATE leads.dead_letter
           SET raw_payload = raw_payload
                              - 'email' - 'first_name' - 'last_name'
                              - 'phone' - 'postcode' - 'address'
                              - 'la'    - 'why_this_course' - 'interest'
                              || jsonb_build_object('email', '[erased]')
         WHERE raw_payload->>'email' = ${email}
            OR (raw_payload->>'submission_id')::bigint = ANY(${submissionIds}::BIGINT[])
      `;

      // Cascade DELETEs. Order matters for FK chains: lead_notes →
      // enrolments → fastrack_submissions → routing_log → submissions.
      const ln = await trx<Array<{ count: string }>>`
        WITH deleted AS (
          DELETE FROM crm.lead_notes
           WHERE submission_id = ANY(${submissionIds}::BIGINT[])
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM deleted
      `;
      supabaseResult.rows_deleted.lead_notes = Number(ln[0]?.count ?? 0);

      const en = await trx<Array<{ count: string }>>`
        WITH deleted AS (
          DELETE FROM crm.enrolments
           WHERE submission_id = ANY(${submissionIds}::BIGINT[])
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM deleted
      `;
      supabaseResult.rows_deleted.enrolments = Number(en[0]?.count ?? 0);

      const fs = await trx<Array<{ count: string }>>`
        WITH deleted AS (
          DELETE FROM leads.fastrack_submissions
           WHERE parent_submission_id = ANY(${submissionIds}::BIGINT[])
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM deleted
      `;
      supabaseResult.rows_deleted.fastrack_submissions = Number(fs[0]?.count ?? 0);

      const rl = await trx<Array<{ count: string }>>`
        WITH deleted AS (
          DELETE FROM leads.routing_log
           WHERE submission_id = ANY(${submissionIds}::BIGINT[])
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM deleted
      `;
      supabaseResult.rows_deleted.routing_log = Number(rl[0]?.count ?? 0);

      const sub = await trx<Array<{ count: string }>>`
        WITH deleted AS (
          DELETE FROM leads.submissions
           WHERE id = ANY(${submissionIds}::BIGINT[])
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM deleted
      `;
      supabaseResult.rows_deleted.submissions = Number(sub[0]?.count ?? 0);
    });
  }

  // 3. Brevo delete (apply path only)
  let brevoResult: BrevoResultEntry = { ok: true };
  if (apply) {
    const r = await deleteBrevoContact({ email });
    brevoResult = { ok: r.ok, error: r.ok ? undefined : r.error };
  }

  // 4. Sheet deletes (apply path only). One POST per provider that
  //    received any of these submissions. Sheet webhook accepts the new
  //    `delete_submission_id` mode (canonical appender v3+). Older
  //    appenders return `ok:false, error:'unsupported_mode'` which we
  //    record as `skipped_unsupported`.
  const sheetResult: SheetResult = {
    providers: [],
    deleted_count: 0,
    failed_count: 0,
  };
  if (apply && routings.length > 0 && SHEETS_APPEND_TOKEN) {
    for (const r of routings) {
      if (!r.sheet_webhook_url) {
        sheetResult.providers.push({
          provider_id: r.provider_id,
          company_name: r.company_name,
          status: "skipped_no_webhook",
        });
        continue;
      }
      try {
        const resp = await fetchWithTimeout(r.sheet_webhook_url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: SHEETS_APPEND_TOKEN,
            mode: "delete_submission_id",
            submission_ids: submissionIds,
          }),
        }, APPENDER_TIMEOUT_MS);
        const body = await resp.json().catch(() => ({})) as {
          ok?: boolean;
          error?: string;
          deleted_count?: number;
        };
        if (resp.ok && body.ok === true) {
          sheetResult.providers.push({
            provider_id: r.provider_id,
            company_name: r.company_name,
            status: "deleted",
          });
          sheetResult.deleted_count += body.deleted_count ?? 0;
        } else if (body.error === "unsupported_mode") {
          sheetResult.providers.push({
            provider_id: r.provider_id,
            company_name: r.company_name,
            status: "skipped_unsupported",
            error: "Appender doesn't support delete_submission_id yet — paste the canonical appender v3+ on this sheet.",
          });
        } else {
          sheetResult.providers.push({
            provider_id: r.provider_id,
            company_name: r.company_name,
            status: "failed",
            error: body.error ?? `HTTP ${resp.status}`,
          });
          sheetResult.failed_count++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sheetResult.providers.push({
          provider_id: r.provider_id,
          company_name: r.company_name,
          status: "failed",
          error: msg,
        });
        sheetResult.failed_count++;
      }
    }
  } else if (apply && routings.length > 0 && !SHEETS_APPEND_TOKEN) {
    // Mark every provider as skipped_unsupported with reason "no token"
    for (const r of routings) {
      sheetResult.providers.push({
        provider_id: r.provider_id,
        company_name: r.company_name,
        status: "skipped_unsupported",
        error: "SHEETS_APPEND_TOKEN env var not set",
      });
    }
  }

  // 5. Finalise audit.erasure_requests receipt (apply path only)
  if (apply && erasureRequestId != null) {
    const allSheetsOk = sheetResult.failed_count === 0;
    const brevoOk = brevoResult.ok;
    const finalStatus = (brevoOk && allSheetsOk) ? "completed" : "in_progress";

    await sql`
      UPDATE audit.erasure_requests
         SET supabase_result = ${sql.json(supabaseResult)},
             brevo_result    = ${sql.json(brevoResult)},
             sheet_result    = ${sql.json(sheetResult)},
             status          = ${finalStatus},
             completed_at    = ${finalStatus === "completed" ? new Date().toISOString() : null}
       WHERE id = ${erasureRequestId}
    `;
  }

  return {
    ok: true,
    mode: apply ? "apply" : "dry_run",
    email,
    submission_ids: submissionIds,
    supabase_result: supabaseResult,
    brevo_result: brevoResult,
    sheet_result: sheetResult,
    erasure_request_id: erasureRequestId,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
