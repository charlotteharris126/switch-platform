// Edge Function: backfill-sheet-submission-ids
//
// One-shot legacy cleanup. Before 2026-05-07 provider sheets didn't have
// a Submission ID column — when the column was added (for fastrack),
// existing data rows were left with a blank cell because no backfill
// ran. Today's reconcile / republish flows match rows by Submission ID,
// so any sheet row without one is invisible to the auto-update path.
//
// This function fixes the historic gap: pulls the sheet's currently
// unidentified rows, matches each against DB leads via email + course,
// and writes the matched submission_id back into the sheet's Submission
// ID column. After running, every old row is findable by the regular
// reconcile / republish flows.
//
// Safety:
//   - Only writes the Submission ID column. No other cell is touched.
//   - Only writes to currently-blank cells. Never overwrites an existing ID.
//   - Skips rows where match is ambiguous (>1 DB candidate) or absent.
//   - Skipped rows are reported back per-row so the operator can spot-fix.
//   - Idempotent — re-running after a successful apply is a no-op.
//
// Auth: x-audit-key matched against AUDIT_SHARED_SECRET in vault.
// Body: { "provider_id": "<id>", "apply": boolean }

import postgres from "npm:postgres@3";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) throw new Error("SUPABASE_DB_URL not set");
const SHEETS_APPEND_TOKEN = Deno.env.get("SHEETS_APPEND_TOKEN");
if (!SHEETS_APPEND_TOKEN) throw new Error("SHEETS_APPEND_TOKEN not set");

const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 20, prepare: false });

const APPENDER_TIMEOUT_MS = 30000;

interface SheetUnidentifiedRow {
  row_index: number;
  email?: string;
  course?: string;
  course_id?: string;
  submitted_at?: string | number | Date;
  name?: string;
  first_name?: string;
  last_name?: string;
}

interface ProposedAssignment {
  row_index: number;
  submission_id: number;
  match_reason: string;
  sheet: { email: string; course: string; name: string };
}

interface Skip {
  row_index: number;
  reason: "no_email" | "no_course" | "no_db_match" | "ambiguous_db_match";
  sheet: { email: string | null; course: string | null; name: string | null };
  candidate_ids?: number[];
}

interface RunSummary {
  mode: "dry_run" | "apply";
  provider_id: string;
  company_name: string | null;
  sheet_rows_unidentified: number;
  proposed_assignments: ProposedAssignment[];
  skipped: Skip[];
  applied_count: number;
  skipped_already_populated: number;
  errors: string[];
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

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
  if (provided !== expected) return new Response("Unauthorized", { status: 401 });

  let body: { provider_id?: unknown; apply?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const providerId = typeof body.provider_id === "string" ? body.provider_id : null;
  if (!providerId) return json({ ok: false, error: "provider_id required" }, 400);
  const apply = body.apply === true;

  try {
    const summary = await run(providerId, apply);
    return json({ ok: true, ...summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("backfill failed:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

async function run(providerId: string, apply: boolean): Promise<RunSummary> {
  // 1. Load provider's sheet webhook
  const [provider] = await sql<Array<{ company_name: string; sheet_webhook_url: string | null }>>`
    SELECT company_name, sheet_webhook_url FROM crm.providers WHERE provider_id = ${providerId} LIMIT 1
  `;
  if (!provider) throw new Error(`provider not found: ${providerId}`);
  if (!provider.sheet_webhook_url) throw new Error(`provider ${providerId} has no sheet_webhook_url`);

  // 2. Ask sheet for rows where Submission ID is blank
  const unidentified = await fetchUnidentifiedRows(provider.sheet_webhook_url);

  // 3. For each, look up the DB match by email + course (when both present)
  const proposed: ProposedAssignment[] = [];
  const skipped: Skip[] = [];
  // Track IDs already assigned in this batch so two sheet rows can't get
  // the same DB id. Surfaced today when re-applications (parent+child on
  // the same email+course) caused both legacy sheet rows to be assigned
  // to the parent ID, then republish errored "2 rows match" on apply.
  const assignedIds = new Set<number>();

  for (const row of unidentified) {
    const email = (row.email ?? "").toString().trim().toLowerCase();
    const courseRaw = (row.course_id ?? row.course ?? "").toString().trim();
    const name = composeName(row);
    const sheetSubmittedAt = parseSheetTimestamp(row.submitted_at);

    if (!email) {
      skipped.push({
        row_index: row.row_index,
        reason: "no_email",
        sheet: { email: null, course: courseRaw || null, name },
      });
      continue;
    }

    // Candidates: routed-to-provider, non-DQ, matching email. INCLUDES
    // children (parent_submission_id IS NOT NULL) so re-applications can
    // be matched to their own row. Course match enforced when sheet
    // provided a course. Order by submitted_at so parent (older) is
    // listed first when ties happen.
    const candidatesAll = courseRaw
      ? await sql<Array<{ id: number; submitted_at: string; course_id: string | null; parent_submission_id: number | string | null }>>`
          SELECT id, submitted_at, course_id, parent_submission_id
            FROM leads.submissions
           WHERE primary_routed_to = ${providerId}
             AND is_dq IS NOT TRUE
             AND archived_at IS NULL
             AND LOWER(TRIM(email)) = ${email}
             AND LOWER(TRIM(course_id)) = ${courseRaw.toLowerCase()}
           ORDER BY submitted_at
        `
      : await sql<Array<{ id: number; submitted_at: string; course_id: string | null; parent_submission_id: number | string | null }>>`
          SELECT id, submitted_at, course_id, parent_submission_id
            FROM leads.submissions
           WHERE primary_routed_to = ${providerId}
             AND is_dq IS NOT TRUE
             AND archived_at IS NULL
             AND LOWER(TRIM(email)) = ${email}
           ORDER BY submitted_at
        `;

    // Drop any candidate already assigned in this batch (one ID per
    // sheet row — never two sheet rows on the same DB id).
    const candidates = candidatesAll.filter((c) => !assignedIds.has(Number(c.id)));

    if (candidates.length === 0) {
      skipped.push({
        row_index: row.row_index,
        reason: candidatesAll.length === 0 ? "no_db_match" : "ambiguous_db_match",
        sheet: { email, course: courseRaw || null, name },
        candidate_ids: candidatesAll.map((c) => Number(c.id)),
      });
      continue;
    }

    let chosen: typeof candidates[number];
    let matchReason: string;
    if (candidates.length === 1) {
      chosen = candidates[0];
      matchReason = courseRaw ? "email + course (single candidate)" : "email (single candidate)";
    } else if (sheetSubmittedAt != null) {
      // Multiple candidates and the sheet has a usable submitted_at —
      // pick the candidate whose submitted_at is closest. Re-applications
      // and parents land on different sheet rows because each row's
      // submitted_at is closer to its own DB record than to the sibling's.
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < candidates.length; i++) {
        const dbTime = new Date(candidates[i].submitted_at).getTime();
        const dist = Math.abs(dbTime - sheetSubmittedAt);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
      chosen = candidates[bestIdx];
      matchReason = `email + course + submitted_at proximity (${Math.round(bestDist / 1000)}s)`;
    } else {
      // Multiple candidates and no usable submitted_at signal — too risky
      // to guess. Skip as ambiguous; operator hand-fixes if needed.
      skipped.push({
        row_index: row.row_index,
        reason: "ambiguous_db_match",
        sheet: { email, course: courseRaw || null, name },
        candidate_ids: candidates.map((c) => Number(c.id)),
      });
      continue;
    }

    assignedIds.add(Number(chosen.id));
    proposed.push({
      row_index: row.row_index,
      submission_id: Number(chosen.id),
      match_reason: matchReason,
      sheet: { email, course: courseRaw, name },
    });
  }

  if (!apply) {
    return {
      mode: "dry_run",
      provider_id: providerId,
      company_name: provider.company_name,
      sheet_rows_unidentified: unidentified.length,
      proposed_assignments: proposed,
      skipped,
      applied_count: 0,
      skipped_already_populated: 0,
      errors: [],
    };
  }

  // 4. Apply: call appender's write_submission_ids mode with the matched
  //    assignments. Apps Script does the actual cell writes (only-if-blank
  //    guard runs there too as a belt-and-braces check).
  const writeResp = await callAppender(provider.sheet_webhook_url, {
    mode: "write_submission_ids",
    assignments: proposed.map((p) => ({
      row_index: p.row_index,
      submission_id: p.submission_id,
    })),
  });

  return {
    mode: "apply",
    provider_id: providerId,
    company_name: provider.company_name,
    sheet_rows_unidentified: unidentified.length,
    proposed_assignments: proposed,
    skipped,
    applied_count: typeof writeResp.written === "number" ? writeResp.written : 0,
    skipped_already_populated:
      typeof writeResp.skipped_already_populated === "number"
        ? writeResp.skipped_already_populated
        : 0,
    errors: Array.isArray(writeResp.errors) ? writeResp.errors : [],
  };
}

function composeName(r: SheetUnidentifiedRow): string {
  if (r.name) return String(r.name);
  const parts = [r.first_name, r.last_name].filter(Boolean).map(String);
  return parts.join(" ") || "—";
}

// Sheet cells can come back from Apps Script as ISO strings, Date
// objects (serialised via JSON.stringify to ISO strings), or numbers
// (Excel-style serial dates if the cell is formatted that way).
// Returns milliseconds since epoch, or null when unparseable.
function parseSheetTimestamp(v: string | number | Date | undefined): number | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") {
    // Apps Script numeric dates are days since 1899-12-30. If the value
    // looks like a small integer (< 100000), treat as a serial date.
    // Otherwise assume ms-since-epoch (already-converted timestamp).
    if (v < 100000) {
      const SERIAL_EPOCH = Date.UTC(1899, 11, 30);
      return SERIAL_EPOCH + v * 86400000;
    }
    return v;
  }
  if (typeof v === "string") {
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function fetchUnidentifiedRows(webhookUrl: string): Promise<SheetUnidentifiedRow[]> {
  const body = await callAppender(webhookUrl, { mode: "read_rows_missing_submission_id" });
  if (body.ok === false) throw new Error(`appender ${body.error ?? "unknown"}`);
  return (body.rows as SheetUnidentifiedRow[]) ?? [];
}

async function callAppender(webhookUrl: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APPENDER_TIMEOUT_MS);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: SHEETS_APPEND_TOKEN, ...body }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`appender HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
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
