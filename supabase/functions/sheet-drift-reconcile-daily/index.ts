// Edge Function: sheet-drift-reconcile-daily
//
// Daily proactive sheet ↔ DB drift detector. Counterpart to
// `republish-provider-sheet` (the recovery tool): this cron flags drift
// before the operator goes looking, the republish tool fixes it.
//
// For every active provider with `crm.providers.sheet_webhook_url` set:
//   1. POST `{token, mode: "read_all_status"}` to the appender.
//   2. Build a map of sheet rows by submission_id.
//   3. Load DB-routed leads for the same provider (matches republish's
//      eligible-rows query, so the two tools always agree on scope).
//   4. For each routed lead, project DB state through the shared
//      `statusToSheetLabel` / `lostReasonHumanText` transformers (the
//      same projection republish writes with) and compare against the
//      sheet's cell values. Record drift kinds: status, lost_reason,
//      fastracked, missing_from_sheet.
//   5. Dedup against existing unresolved drift dead_letter rows for the
//      same (provider_id, submission_id, kinds). Insert only the truly
//      new drift.
//   6. If any new drift inserted, email the owner a summary.
//
// Why dead_letter as the surface: it's already the operator's queue and
// where Data health renders unresolved ops issues. A drift row points
// the operator at the recovery tool (republish-provider-sheet panel in
// Data health) which clears the row on next run via the dead_letter
// resolution path (Mira's Monday audit also picks them up).
//
// Auth: x-audit-key / AUDIT_SHARED_SECRET (same pattern as the other crons).
// Deploy with --no-verify-jwt — auth is the audit-key header.
//
// Scheduled by migration 0115 at 06:00 UTC (07:00 BST), well before
// sheet-edit-mirror'd morning provider activity so detection lags by
// at most ~24h.

import postgres from "npm:postgres@3";
import { sendBrevoEmail } from "../_shared/brevo.ts";
import { getAdminDashboardUrl, getOwnerEmail } from "../_shared/owner-email.ts";
import { lostReasonHumanText, statusToSheetLabel } from "../_shared/sheet-status.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) throw new Error("SUPABASE_DB_URL is not set.");
const SHEETS_APPEND_TOKEN = Deno.env.get("SHEETS_APPEND_TOKEN");
if (!SHEETS_APPEND_TOKEN) throw new Error("SHEETS_APPEND_TOKEN is not set.");

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

// Appender HTTP timeout. Apps Script returns a few-hundred-row table in
// well under a second normally; 15s catches the 99th percentile cold-
// start without holding the cron up for a hung sheet.
const APPENDER_TIMEOUT_MS = 15000;

interface Provider {
  provider_id: string;
  company_name: string;
  sheet_webhook_url: string;
}

interface SheetRow {
  submission_id: string;
  status?: string;
  lost_reason?: string;
  fastracked?: string;
  fastrack_notes?: string;
}

interface DbLead {
  submission_id: number;
  status: string;
  lost_reason: string | null;
  fastracked_at: string | null;
}

type DriftKind =
  | "status"
  | "lost_reason"
  | "fastracked"
  | "missing_from_sheet";

interface DriftRow {
  provider_id: string;
  company_name: string;
  submission_id: number;
  kinds: DriftKind[];
  db_state: {
    status: string;
    status_label: string;
    lost_reason: string | null;
    fastracked: boolean;
  };
  sheet_state: {
    status: string | null;
    lost_reason: string | null;
    fastracked: string | null;
  } | null;
}

interface ProviderResult {
  provider_id: string;
  company_name: string;
  status: "ok" | "skipped" | "error";
  reason?: string;
  leads_checked: number;
  drift_total: number;
  drift_new: number;
  drift_persisting: number;
  drift_self_cleaned?: number;
  sheet_rows_skipped_no_sid?: number;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }

  const providedKey = req.headers.get("x-audit-key");
  if (!providedKey) return new Response("Unauthorized", { status: 401 });

  let expectedKey: string;
  try {
    const [row] = await sql<Array<{ secret: string }>>`
      SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
    `;
    expectedKey = row?.secret ?? "";
    if (!expectedKey) throw new Error("AUDIT_SHARED_SECRET not in vault");
  } catch (err) {
    console.error("vault secret fetch failed:", String(err));
    return json({ error: "AUDIT_SHARED_SECRET not retrievable from vault" }, 500);
  }
  if (providedKey !== expectedKey) {
    return new Response("Unauthorized", { status: 401 });
  }

  let providers: Provider[];
  try {
    providers = await sql<Provider[]>`
      SELECT provider_id, company_name, sheet_webhook_url
        FROM crm.providers
       WHERE active = true
         AND COALESCE(is_demo, false) = false
         AND sheet_webhook_url IS NOT NULL
       ORDER BY provider_id
    `;
  } catch (err) {
    console.error("provider load failed:", String(err));
    return json({ error: `provider load: ${String(err)}` }, 500);
  }

  const providerResults: ProviderResult[] = [];
  let totalNewDrift = 0;
  const newDriftRows: DriftRow[] = [];

  for (const provider of providers) {
    const result = await checkProvider(provider, newDriftRows);
    providerResults.push(result);
    totalNewDrift += result.drift_new;
  }

  let alertSent = false;
  if (totalNewDrift > 0) {
    alertSent = await sendOwnerSummary(providerResults, newDriftRows);
  }

  return json({
    checked_at: new Date().toISOString(),
    providers_checked: providers.length,
    providers: providerResults,
    new_drift_total: totalNewDrift,
    alert_email_sent: alertSent,
  }, 200);
});

async function checkProvider(
  provider: Provider,
  newDriftRows: DriftRow[],
): Promise<ProviderResult> {
  // 1. Pull sheet state via the appender's read_all_status mode
  let sheetRows: SheetRow[];
  let skippedNoSid = 0;
  try {
    const resp = await fetchWithTimeout(provider.sheet_webhook_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: SHEETS_APPEND_TOKEN,
        mode: "read_all_status",
      }),
    }, APPENDER_TIMEOUT_MS);
    if (!resp.ok) {
      await logProviderSkip(provider, `appender HTTP ${resp.status}`);
      return {
        provider_id: provider.provider_id,
        company_name: provider.company_name,
        status: "error",
        reason: `appender HTTP ${resp.status}`,
        leads_checked: 0,
        drift_total: 0,
        drift_new: 0,
        drift_persisting: 0,
      };
    }
    const body = await resp.json() as {
      ok?: boolean;
      error?: string;
      rows?: SheetRow[];
      skipped_no_submission_id?: number;
    };
    if (body.ok === false) {
      await logProviderSkip(provider, `appender ok=false: ${body.error ?? "unknown"}`);
      return {
        provider_id: provider.provider_id,
        company_name: provider.company_name,
        status: "skipped",
        reason: body.error ?? "unknown",
        leads_checked: 0,
        drift_total: 0,
        drift_new: 0,
        drift_persisting: 0,
      };
    }
    sheetRows = body.rows ?? [];
    skippedNoSid = body.skipped_no_submission_id ?? 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logProviderSkip(provider, `fetch failed: ${msg}`);
    return {
      provider_id: provider.provider_id,
      company_name: provider.company_name,
      status: "error",
      reason: `fetch failed: ${msg}`,
      leads_checked: 0,
      drift_total: 0,
      drift_new: 0,
      drift_persisting: 0,
    };
  }

  // 2. Index sheet rows by submission_id
  const sheetById = new Map<string, SheetRow>();
  for (const r of sheetRows) sheetById.set(r.submission_id, r);

  // 3. Load DB-routed leads (matches republish-provider-sheet's scope)
  let dbLeads: DbLead[];
  try {
    dbLeads = await sql<DbLead[]>`
      SELECT s.id AS submission_id,
             COALESCE(e.status, 'open') AS status,
             e.lost_reason,
             s.fastracked_at
        FROM leads.submissions s
   LEFT JOIN crm.enrolments e ON e.submission_id = s.id
       WHERE s.primary_routed_to = ${provider.provider_id}
         AND s.is_dq IS NOT TRUE
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`db lead load failed for ${provider.provider_id}:`, msg);
    return {
      provider_id: provider.provider_id,
      company_name: provider.company_name,
      status: "error",
      reason: `db lead load: ${msg}`,
      leads_checked: 0,
      drift_total: 0,
      drift_new: 0,
      drift_persisting: 0,
    };
  }

  // 4. Load existing unresolved drift rows for this provider so we dedup
  // AND can self-clean rows whose drift no longer exists. Each row carries
  // its id so step 7 can UPDATE the stale ones.
  let priorByKey: Map<string, number[]>;
  try {
    const priorRows = await sql<Array<{
      id: number;
      submission_id: string;
      kinds: string[];
    }>>`
      SELECT id,
             raw_payload->>'submission_id' AS submission_id,
             ARRAY(
               SELECT jsonb_array_elements_text(raw_payload->'kinds')
             ) AS kinds
        FROM leads.dead_letter
       WHERE source = 'sheet_drift_detected'
         AND replayed_at IS NULL
         AND raw_payload->>'provider_id' = ${provider.provider_id}
    `;
    priorByKey = new Map();
    for (const r of priorRows) {
      const k = driftKey(r.submission_id, r.kinds);
      const list = priorByKey.get(k) ?? [];
      list.push(r.id);
      priorByKey.set(k, list);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`prior drift load failed for ${provider.provider_id}:`, msg);
    priorByKey = new Map();
  }
  const priorKey = new Set(priorByKey.keys());

  // 5. Compare each DB lead against its sheet row
  const drifts: DriftRow[] = [];
  for (const lead of dbLeads) {
    const expectedLabel = statusToSheetLabel(lead.status);
    const expectedLostReason = lead.status === "lost"
      ? lostReasonHumanText(lead.lost_reason)
      : "";
    const expectedFastracked = lead.fastracked_at != null;

    const sheetRow = sheetById.get(String(lead.submission_id));
    if (!sheetRow) {
      drifts.push({
        provider_id: provider.provider_id,
        company_name: provider.company_name,
        submission_id: lead.submission_id,
        kinds: ["missing_from_sheet"],
        db_state: {
          status: lead.status,
          status_label: expectedLabel,
          lost_reason: lead.lost_reason,
          fastracked: expectedFastracked,
        },
        sheet_state: null,
      });
      continue;
    }

    const kinds: DriftKind[] = [];
    // Case-insensitive comparison: provider sheets historically have
    // "Presumed Enrolled" with title-case E, but our canonical label is
    // "Presumed enrolled" with lower-case e. The forward `sheetLabelToStatus`
    // already normalises case for sheet → DB direction; the drift reconciler
    // needs to do the same on the comparison side or every Presumed lead
    // shows as cosmetic drift forever.
    const sheetStatus = (sheetRow.status ?? "").trim().toLowerCase();
    const expectedLabelNorm = expectedLabel.toLowerCase();
    if (sheetStatus !== expectedLabelNorm) {
      // Sheet "" (blank) is a benign state when DB is "open" + nothing
      // has been written yet — append wrote nothing because the lead
      // is brand-new. Treat blank vs "Open" as drift anyway; the sheet
      // has a default dropdown value and "Open" should be there for
      // routed leads. Blank means the cell was never populated; that
      // is itself drift.
      kinds.push("status");
    }
    // Only flag lost_reason drift when the sheet ACTUALLY HAS a lost_reason
    // column. Current pilot sheets (EMS, WYK, CD) have a Status column but
    // no separate Lost Reason column — the appender's read_all_status mode
    // returns `lost_reason: undefined` for those. Flagging drift in that
    // case is structurally impossible to resolve (you can't write a value
    // into a column that doesn't exist) and just noise. When a provider
    // adds a Lost Reason column to their sheet, the appender will start
    // returning a non-undefined value and this check kicks in normally.
    if (sheetRow.lost_reason !== undefined) {
      const sheetLost = (sheetRow.lost_reason ?? "").trim().toLowerCase();
      const expectedLostNorm = expectedLostReason.toLowerCase();
      if (sheetLost !== expectedLostNorm) kinds.push("lost_reason");
    }
    const sheetFast = (sheetRow.fastracked ?? "").trim().toLowerCase();
    const sheetFastFlag = sheetFast === "yes";
    if (sheetFastFlag !== expectedFastracked) kinds.push("fastracked");

    if (kinds.length === 0) continue;
    drifts.push({
      provider_id: provider.provider_id,
      company_name: provider.company_name,
      submission_id: lead.submission_id,
      kinds,
      db_state: {
        status: lead.status,
        status_label: expectedLabel,
        lost_reason: lead.lost_reason,
        fastracked: expectedFastracked,
      },
      sheet_state: {
        status: sheetRow.status ?? null,
        lost_reason: sheetRow.lost_reason ?? null,
        fastracked: sheetRow.fastracked ?? null,
      },
    });
  }

  // 6. Split into new vs persisting and insert new into dead_letter
  let driftNew = 0;
  let driftPersisting = 0;
  for (const d of drifts) {
    const key = driftKey(String(d.submission_id), d.kinds);
    if (priorKey.has(key)) {
      driftPersisting++;
      continue;
    }
    driftNew++;
    newDriftRows.push(d);
    try {
      await sql.begin(async (trx) => {
        await trx`SET LOCAL ROLE functions_writer`;
        await trx`
          INSERT INTO leads.dead_letter (source, error_context, raw_payload)
          VALUES (
            'sheet_drift_detected',
            ${
            `sheet drift for ${d.company_name} submission ${d.submission_id}: ${d.kinds.join(", ")}`
          },
            ${
            sql.json({
              provider_id: d.provider_id,
              company_name: d.company_name,
              submission_id: d.submission_id,
              kinds: d.kinds,
              db_state: d.db_state,
              sheet_state: d.sheet_state,
            })
          }
          )
        `;
      });
    } catch (err) {
      console.error(`dead_letter insert failed for drift ${d.submission_id}:`, String(err));
    }
  }

  // 7. Self-clean stale dead_letter rows. Any prior row whose drift key
  // isn't present in this run's `drifts` is no longer drifting — sheet
  // and DB now agree on that submission_id × kind combo. Mark the row
  // replayed so /admin/errors stops surfacing it. This makes the table
  // self-converge: clear up real drift via republish or sheet edits,
  // and the alert clears itself on the next run rather than sitting
  // there until someone clicks "I've handled this".
  const currentKeys = new Set(drifts.map((d) => driftKey(String(d.submission_id), d.kinds)));
  const staleIds: number[] = [];
  for (const [key, ids] of priorByKey) {
    if (!currentKeys.has(key)) staleIds.push(...ids);
  }
  let driftSelfCleaned = 0;
  if (staleIds.length > 0) {
    try {
      const result = await sql.begin(async (trx) => {
        await trx`SET LOCAL ROLE functions_writer`;
        return await trx`
          UPDATE leads.dead_letter
             SET replayed_at = now()
           WHERE id = ANY(${staleIds})
             AND replayed_at IS NULL
        `;
      });
      driftSelfCleaned = result.count;
    } catch (err) {
      console.error(`self-clean update failed for ${provider.provider_id}:`, String(err));
    }
  }

  return {
    provider_id: provider.provider_id,
    company_name: provider.company_name,
    status: "ok",
    leads_checked: dbLeads.length,
    drift_total: drifts.length,
    drift_new: driftNew,
    drift_persisting: driftPersisting,
    drift_self_cleaned: driftSelfCleaned,
    sheet_rows_skipped_no_sid: skippedNoSid,
  };
}

// Stable key for dedup. Sort kinds so order doesn't matter.
function driftKey(submissionId: string, kinds: string[]): string {
  return `${submissionId}|${[...kinds].sort().join(",")}`;
}

async function logProviderSkip(provider: Provider, reason: string): Promise<void> {
  // One per-provider dead_letter row per failed read attempt so the
  // operator can see "EMS sheet reachable but missing Submission ID
  // column" etc. without spelunking logs. Dedup at the day level — if
  // the same provider failed for the same reason within the last
  // 23 hours, don't repeat.
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        INSERT INTO leads.dead_letter (source, error_context, raw_payload)
        SELECT 'sheet_drift_provider_skipped',
               ${`drift cron could not read ${provider.company_name} sheet: ${reason}`},
               ${
        sql.json({
          provider_id: provider.provider_id,
          company_name: provider.company_name,
          reason,
        })
      }
         WHERE NOT EXISTS (
           SELECT 1 FROM leads.dead_letter
            WHERE source = 'sheet_drift_provider_skipped'
              AND received_at > now() - interval '23 hours'
              AND raw_payload->>'provider_id' = ${provider.provider_id}
              AND raw_payload->>'reason' = ${reason}
         )
      `;
    });
  } catch (err) {
    console.error(`logProviderSkip insert failed:`, String(err));
  }
}

async function sendOwnerSummary(
  results: ProviderResult[],
  newDriftRows: DriftRow[],
): Promise<boolean> {
  const ownerEmail = getOwnerEmail();
  if (!ownerEmail) {
    console.error("OWNER_NOTIFICATION_EMAIL / BREVO_SENDER_EMAIL not set; skipping summary email");
    return false;
  }

  const dash = getAdminDashboardUrl();
  const totalNew = newDriftRows.length;
  const byProvider: Record<string, { name: string; count: number }> = {};
  for (const d of newDriftRows) {
    if (!byProvider[d.provider_id]) byProvider[d.provider_id] = { name: d.company_name, count: 0 };
    byProvider[d.provider_id].count++;
  }

  const summaryRows = Object.entries(byProvider)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([pid, info]) => `<li><strong>${escapeHtml(info.name)}</strong>: ${info.count} new drift row${info.count === 1 ? "" : "s"} <a href="${dash}/admin/errors?republish=${encodeURIComponent(pid)}">republish</a></li>`)
    .join("");

  const sampleRows = newDriftRows.slice(0, 10).map((d) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:12px">${escapeHtml(d.company_name)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-family:monospace;font-size:12px"><a href="${dash}/admin/leads/${d.submission_id}">#${d.submission_id}</a></td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:12px">${escapeHtml(d.kinds.join(", "))}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:12px">${escapeHtml(d.db_state.status_label)}${d.db_state.lost_reason ? ` (${escapeHtml(lostReasonHumanText(d.db_state.lost_reason))})` : ""}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:12px">${escapeHtml(d.sheet_state?.status ?? "—")}${d.sheet_state?.lost_reason ? ` (${escapeHtml(d.sheet_state.lost_reason)})` : ""}</td>
    </tr>
  `).join("");

  const htmlContent = `
    <p>${totalNew} new sheet ↔ DB drift row${totalNew === 1 ? "" : "s"} detected this morning. Use the republish tool linked below to bring each sheet back into agreement with the DB. The DB is authoritative — drift is always sheet-stale, never DB-wrong.</p>
    <p><strong>By provider:</strong></p>
    <ul>${summaryRows}</ul>
    <p><strong>Sample (up to 10):</strong></p>
    <table style="border-collapse:collapse;width:100%;font-size:12px">
      <thead><tr style="background:#f4f4f5">
        <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #ddd">Provider</th>
        <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #ddd">Lead</th>
        <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #ddd">Drift kinds</th>
        <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #ddd">DB says</th>
        <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #ddd">Sheet says</th>
      </tr></thead>
      <tbody>${sampleRows}</tbody>
    </table>
    <p style="margin-top:16px;color:#71717a;font-size:12px">Source: <code>sheet-drift-reconcile-daily</code> cron, 06:00 UTC. Persisting drift from prior days is suppressed from this email; full unresolved list at <a href="${dash}/admin/errors">${dash}/admin/errors</a>.</p>
  `;

  try {
    const result = await sendBrevoEmail({
      to: [{ email: ownerEmail }],
      subject: `Switchable sheet drift: ${totalNew} new row${totalNew === 1 ? "" : "s"} this morning`,
      htmlContent,
      brand: "switchleads",
      tags: ["alert", "sheet-drift", "cron"],
    });
    if (!result.ok) {
      console.error("drift summary email send failed:", result.error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("drift summary email send threw:", String(err));
    return false;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
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
