// Edge Function: reconcile-sheet-to-db
//
// Bidirectional sibling to `republish-provider-sheet`. While republish does
// DB → sheet (good when DB is fresher and the sheet needs catching up),
// this function does **sheet → DB** (good when a provider has been working
// the sheet but sheet-edit-mirror missed the propagation, e.g. WYK's
// 2026-05-09 backlog of 9 open rows that should have been Lost / Cannot
// reach according to the sheet).
//
// Together the pair gives the operator a one-button cure for any DB ↔ sheet
// drift surfaced by `sheet-drift-reconcile-daily`:
//   - "Apply sheet → DB" (this function) when the provider's been editing
//     the sheet outside the mirror path
//   - "Apply DB → sheet" (republish-provider-sheet) when DB has been
//     edited via admin/portal and the sheet hasn't caught up
//
// What it does NOT do: collapse "Calling" rows (sheet collapses three
// attempt_*_no_answer states into one label, reversing it is ambiguous —
// let sheet-edit-mirror's Channel A handle attempt progression on real
// edit events). DB-open + sheet-blank rows are also skipped (treated as
// no signal; provider hasn't touched it yet).
//
// Auth: x-audit-key matched against AUDIT_SHARED_SECRET in vault.
//
// Body:
//   {
//     "provider_id": "<id>",
//     "apply": boolean,
//     "submission_ids"?: number[]   // optional whitelist — if omitted,
//                                     all eligible drift rows are in scope
//   }
//
// Response (dry-run + apply):
//   {
//     ok: true,
//     mode: "dry_run" | "apply",
//     provider_id, company_name,
//     drift_eligible_total: 9,           // rows the function CAN flip
//     drift_skipped_ambiguous: 0,         // sheet=Calling / unknown label
//     drift_skipped_no_signal: 0,         // sheet=Open or blank, DB=anything
//     drift_skipped_db_fresher: 0,        // DB=terminal, sheet=open/calling
//                                          //   — needs republish, not this
//     proposed_changes: [
//       { submission_id, kind, from_status, to_status, lost_reason }
//     ],
//     applied_count: 0 (dry_run) | n (apply),
//     errors: [],
//     audit_entries: [ids] (apply only)
//   }
//
// Idempotent: gates each UPDATE on `status = <db_current>` and INSERT on
// "no existing enrolment row for this (submission_id, provider_id)". Safe
// to re-run; second run reports drift_eligible_total = 0.

import postgres from "npm:postgres@3";
import { sheetLabelToStatus } from "../_shared/sheet-status.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) throw new Error("SUPABASE_DB_URL not set");
const SHEETS_APPEND_TOKEN = Deno.env.get("SHEETS_APPEND_TOKEN");
if (!SHEETS_APPEND_TOKEN) throw new Error("SHEETS_APPEND_TOKEN not set");

const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 20, prepare: false });

const APPENDER_TIMEOUT_MS = 15000;

// Terminal statuses we're willing to FLIP DB to via this tool. Excludes
// `enrolled` and `presumed_enrolled` by design: marking a lead enrolled
// has billing consequences, so we only allow that via the explicit admin
// outcome path (which goes through the audit wrapper). This tool is for
// catching lost / cannot_reach / meeting_booked drift only.
const ALLOWED_TARGET_STATUSES = new Set([
  "lost",
  "cannot_reach",
  "enrolment_meeting_booked",
]);

interface SheetRow {
  submission_id: string;
  status?: string;
  lost_reason?: string;
  fastracked?: string;
  fastrack_notes?: string;
}

interface DbLead {
  submission_id: number;
  enrolment_id: number | null;
  routing_log_id: number | null;
  db_status: string; // "open" if no enrolment row, else e.status
  status_updated_at: string | null;
  has_enrolment_row: boolean;
}

type DriftKind =
  | "db_open_sheet_terminal"     // 90% case — apply sheet → DB
  | "db_terminal_sheet_other"    // different terminals — apply sheet → DB
  | "db_missing_sheet_terminal"; // sub 96 case — INSERT enrolment row

interface DriftRow {
  submission_id: number;
  enrolment_id: number | null;
  routing_log_id: number | null;
  kind: DriftKind;
  from_status: string;             // "missing" when no enrolment row exists
  to_status: string;
  lost_reason: string | null;      // defaults to 'other' for lost target
}

interface Skipped {
  submission_id: number;
  reason: "no_signal" | "ambiguous" | "db_fresher" | "target_disallowed";
  db_status: string;
  sheet_status: string | null;
}

interface RunSummary {
  mode: "dry_run" | "apply";
  provider_id: string;
  company_name: string | null;
  drift_eligible_total: number;
  drift_skipped_ambiguous: number;
  drift_skipped_no_signal: number;
  drift_skipped_db_fresher: number;
  drift_skipped_target_disallowed: number;
  // Submission IDs in each skipped bucket, so the panel can pass the
  // db_fresher subset to republish-provider-sheet (avoiding writes for
  // the leads already in agreement).
  drift_db_fresher_submission_ids: number[];
  proposed_changes: DriftRow[];
  applied_count: number;
  errors: string[];
  audit_entries: number[];
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Auth
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

  let body: { provider_id?: unknown; apply?: unknown; submission_ids?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const providerId = typeof body.provider_id === "string" ? body.provider_id : null;
  if (!providerId) return json({ ok: false, error: "provider_id required" }, 400);
  const apply = body.apply === true;
  const whitelist = Array.isArray(body.submission_ids)
    ? new Set((body.submission_ids as unknown[]).filter((x): x is number => typeof x === "number"))
    : null;

  try {
    const summary = await run(providerId, apply, whitelist);
    return json({ ok: true, ...summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("reconcile failed:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

async function run(
  providerId: string,
  apply: boolean,
  whitelist: Set<number> | null,
): Promise<RunSummary> {
  // 1. Load provider + sheet webhook url
  const [provider] = await sql<Array<{
    company_name: string;
    sheet_webhook_url: string | null;
  }>>`
    SELECT company_name, sheet_webhook_url
      FROM crm.providers
     WHERE provider_id = ${providerId}
     LIMIT 1
  `;
  if (!provider) throw new Error(`provider not found: ${providerId}`);
  if (!provider.sheet_webhook_url) {
    throw new Error(`provider ${providerId} has no sheet_webhook_url configured`);
  }

  // 2. Fetch sheet state via read_all_status
  const sheetById = await fetchSheet(provider.sheet_webhook_url);

  // 3. Load DB state for the same provider's routed-non-DQ leads. Also
  //    pull routing_log_id for any "no enrolment row" inserts (matches
  //    016 pattern: INSERT requires a routing_log_id).
  const dbLeads = await sql<DbLead[]>`
    SELECT s.id AS submission_id,
           e.id AS enrolment_id,
           COALESCE(e.routing_log_id, rl.id) AS routing_log_id,
           COALESCE(e.status, 'open') AS db_status,
           e.status_updated_at,
           (e.id IS NOT NULL) AS has_enrolment_row
      FROM leads.submissions s
 LEFT JOIN crm.enrolments e ON e.submission_id = s.id AND e.provider_id = ${providerId}
 LEFT JOIN LATERAL (
        SELECT id FROM leads.routing_log
         WHERE submission_id = s.id AND provider_id = ${providerId}
         ORDER BY routed_at DESC LIMIT 1
      ) rl ON true
     WHERE s.primary_routed_to = ${providerId}
       AND s.is_dq IS NOT TRUE
       AND s.archived_at IS NULL
       AND s.parent_submission_id IS NULL
  `;

  // 4. Classify each lead's drift
  const proposed: DriftRow[] = [];
  const skipped: Skipped[] = [];

  for (const lead of dbLeads) {
    if (whitelist && !whitelist.has(lead.submission_id)) continue;

    const sheetRow = sheetById.get(String(lead.submission_id));
    const sheetLabel = sheetRow?.status ?? null;
    const sheetStatus = sheetLabelToStatus(sheetLabel);

    // No sheet signal → skip
    if (!sheetRow || sheetStatus == null || sheetStatus === "open") {
      // sheet=open + DB=open is fine; sheet=open + DB=terminal needs republish
      // (DB→sheet direction), not this tool.
      if (lead.db_status !== "open" && (sheetStatus === "open" || !sheetRow)) {
        skipped.push({
          submission_id: lead.submission_id,
          reason: "db_fresher",
          db_status: lead.db_status,
          sheet_status: sheetLabel,
        });
        continue;
      }
      // Otherwise: sheet=blank/Open + DB=open → genuinely nothing happening,
      // or sheet=Calling (ambiguous). Either way, no action here.
      if (sheetStatus == null && sheetLabel != null && sheetLabel.toLowerCase().trim() === "calling") {
        skipped.push({
          submission_id: lead.submission_id,
          reason: "ambiguous",
          db_status: lead.db_status,
          sheet_status: sheetLabel,
        });
      } else {
        skipped.push({
          submission_id: lead.submission_id,
          reason: "no_signal",
          db_status: lead.db_status,
          sheet_status: sheetLabel,
        });
      }
      continue;
    }

    // sheetStatus is now a non-open canonical DB status
    if (sheetStatus === lead.db_status) {
      // already in sync — no action
      continue;
    }

    if (!ALLOWED_TARGET_STATUSES.has(sheetStatus)) {
      // Sheet says enrolled / presumed_enrolled — disallowed via this tool.
      // Operator must use the explicit admin outcome path so billing audit
      // fires correctly.
      skipped.push({
        submission_id: lead.submission_id,
        reason: "target_disallowed",
        db_status: lead.db_status,
        sheet_status: sheetLabel,
      });
      continue;
    }

    // Drift: sheet says non-open terminal, DB says different. Classify.
    let kind: DriftKind;
    if (!lead.has_enrolment_row) {
      kind = "db_missing_sheet_terminal";
    } else if (lead.db_status === "open") {
      kind = "db_open_sheet_terminal";
    } else {
      kind = "db_terminal_sheet_other";
    }

    proposed.push({
      submission_id: lead.submission_id,
      enrolment_id: lead.enrolment_id,
      routing_log_id: lead.routing_log_id,
      kind,
      from_status: lead.has_enrolment_row ? lead.db_status : "missing",
      to_status: sheetStatus,
      // Sheet doesn't carry structured lost_reason; default 'other' for
      // lost targets, matching the 016 pattern. Operator can correct the
      // sub-reason post-flip from the admin lead page if needed.
      lost_reason: sheetStatus === "lost" ? "other" : null,
    });
  }

  const skippedAmbiguous = skipped.filter((s) => s.reason === "ambiguous").length;
  const skippedNoSignal = skipped.filter((s) => s.reason === "no_signal").length;
  const skippedDbFresher = skipped.filter((s) => s.reason === "db_fresher").length;
  const dbFresherIds = skipped
    .filter((s) => s.reason === "db_fresher")
    .map((s) => s.submission_id);
  const skippedTargetDisallowed = skipped.filter((s) => s.reason === "target_disallowed").length;

  if (!apply) {
    return {
      mode: "dry_run",
      provider_id: providerId,
      company_name: provider.company_name,
      drift_eligible_total: proposed.length,
      drift_skipped_ambiguous: skippedAmbiguous,
      drift_skipped_no_signal: skippedNoSignal,
      drift_skipped_db_fresher: skippedDbFresher,
      drift_skipped_target_disallowed: skippedTargetDisallowed,
      drift_db_fresher_submission_ids: dbFresherIds,
      proposed_changes: proposed,
      applied_count: 0,
      errors: [],
      audit_entries: [],
    };
  }

  // 5. Apply — single transaction. Each change becomes:
  //    - UPDATE/INSERT crm.enrolments (gated on idempotent WHERE clauses)
  //    - audit.log_system_action entry referencing this batch
  //    Then a single Brevo resync over all touched submission_ids.
  const scriptTag = `reconcile_sheet_to_db_${new Date().toISOString().slice(0, 10)}`;
  const errors: string[] = [];
  const auditEntries: number[] = [];
  let appliedCount = 0;

  const touchedIds: number[] = [];

  for (const change of proposed) {
    try {
      await sql.begin(async (trx) => {
        await trx`SET LOCAL ROLE functions_writer`;

        if (change.kind === "db_missing_sheet_terminal") {
          if (!change.routing_log_id) {
            throw new Error(`no routing_log_id for sub ${change.submission_id}`);
          }
          await trx`
            INSERT INTO crm.enrolments (
              submission_id, routing_log_id, provider_id, status, lost_reason,
              sent_to_provider_at, status_updated_at, notes
            ) VALUES (
              ${change.submission_id}, ${change.routing_log_id}, ${providerId},
              ${change.to_status}, ${change.lost_reason},
              now(), now(),
              ${`Created via reconcile-sheet-to-db ${scriptTag}: sheet had terminal status, no DB enrolment row existed.`}
            )
            ON CONFLICT (submission_id) DO NOTHING
          `;
        } else {
          await trx`
            UPDATE crm.enrolments
               SET status            = ${change.to_status},
                   lost_reason       = ${change.lost_reason},
                   status_updated_at = now(),
                   updated_at        = now()
             WHERE submission_id = ${change.submission_id}
               AND provider_id   = ${providerId}
               AND status        = ${change.from_status}
          `;
        }

        // Audit entry — capture before/after + this script tag
        const [audit] = await trx<Array<{ id: number }>>`
          SELECT audit.log_system_action(
            p_actor        := 'system:reconcile-sheet-to-db',
            p_action       := ${
            change.kind === "db_missing_sheet_terminal"
              ? "sheet_reconcile_enrolment_insert"
              : "sheet_reconcile_status_correction"
          },
            p_target_table := 'crm.enrolments',
            p_target_id    := (
              SELECT id::text FROM crm.enrolments
               WHERE submission_id = ${change.submission_id}
                 AND provider_id = ${providerId}
            ),
            p_before       := ${
            change.kind === "db_missing_sheet_terminal"
              ? null
              : sql.json({ status: change.from_status })
          },
            p_after        := ${
            sql.json({ status: change.to_status, lost_reason: change.lost_reason })
          },
            p_context      := ${
            sql.json({
              submission_id: change.submission_id,
              provider_id: providerId,
              reason: "sheet → DB reconcile via admin panel (live sheet read disagrees with DB)",
              data_ops_script: scriptTag,
              drift_kind: change.kind,
            })
          }
          ) AS id
        `;
        if (audit?.id) auditEntries.push(audit.id);
      });
      appliedCount++;
      touchedIds.push(change.submission_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`submission ${change.submission_id}: ${msg}`);
    }
  }

  // 6. Brevo resync — push SW_ENROL_STATUS for everything we touched.
  //    sync_leads_to_brevo dispatches async via pg_net; we don't wait.
  if (touchedIds.length > 0) {
    try {
      await sql`SELECT crm.sync_leads_to_brevo(${touchedIds}::BIGINT[])`;
    } catch (err) {
      errors.push(`brevo resync dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    mode: "apply",
    provider_id: providerId,
    company_name: provider.company_name,
    drift_eligible_total: proposed.length,
    drift_skipped_ambiguous: skippedAmbiguous,
    drift_skipped_no_signal: skippedNoSignal,
    drift_skipped_db_fresher: skippedDbFresher,
    drift_skipped_target_disallowed: skippedTargetDisallowed,
    drift_db_fresher_submission_ids: dbFresherIds,
    proposed_changes: proposed,
    applied_count: appliedCount,
    errors,
    audit_entries: auditEntries,
  };
}

async function fetchSheet(webhookUrl: string): Promise<Map<string, SheetRow>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APPENDER_TIMEOUT_MS);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: SHEETS_APPEND_TOKEN,
        mode: "read_all_status",
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`appender HTTP ${res.status}`);
    }
    const body = await res.json() as {
      ok?: boolean;
      error?: string;
      rows?: SheetRow[];
    };
    if (body.ok === false) {
      throw new Error(`appender ok=false: ${body.error ?? "unknown"}`);
    }
    const out = new Map<string, SheetRow>();
    for (const r of body.rows ?? []) out.set(r.submission_id, r);
    return out;
  } finally {
    clearTimeout(timeout);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
