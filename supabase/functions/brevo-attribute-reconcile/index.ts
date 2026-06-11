// Edge Function: brevo-attribute-reconcile
//
// Per-attribute drift reconciler between DB-projected SW_* attribute
// values and what Brevo actually holds on each contact. Successor to
// `backfill-referral-fastrack-urls` (the 024 panel): same shape, broader
// coverage — every SW_* attribute that the canonical
// upsertLearnerInBrevo / upsertLearnerInBrevoNoMatch helpers produce.
//
// Why broader is necessary:
//   Any attribute-wiring change in _shared/route-lead.ts (course matrix,
//   regional contacts, enrol-status mapping, etc.) leaves existing Brevo
//   contacts with the old value until the next time they happen to be
//   re-upserted. Marketing broadcasts then render the stale value. The
//   024 reconciler caught this for SW_REFERRAL_URL + SW_FASTRACK_URL only.
//   This function covers the full attribute surface in one shot.
//
// Auth: x-audit-key matched against AUDIT_SHARED_SECRET in vault.
//
// Body: { "apply": boolean, "log_drift"?: boolean }
//   apply=false → dry-run, no writes, returns the diff
//   apply=true  → re-runs upsertLearnerInBrevo / upsertLearnerInBrevoNoMatch
//                 for every drifted contact via the canonical path
//   log_drift=true (dry-run only) → writes one summary leads.dead_letter row
//                 with source='brevo_attribute_drift' when contacts_with_drift > 0.
//                 Daily cron uses this to leave a signal for the /admin/errors
//                 status pill + the drift-digest email.
//
// Response shape (200):
//   {
//     ok: true,
//     mode: "dry_run" | "apply",
//     audience_size: 174,                    // Brevo contacts walked
//     processed: 174,
//     contacts_with_drift: 12,               // ≥1 attribute mismatch
//     contacts_aligned: 152,
//     skipped_no_submission: 8,              // Brevo contact, no DB submission
//     skipped_no_email: 2,
//     per_attribute_drift: {                 // count per attribute
//       SW_COURSE_NAME: 5,
//       SW_REFERRAL_URL: 0,
//       ...
//     },
//     drift_list: [                          // up to 50 drifting contacts
//       { email, submission_id, mode: "matched" | "no_match", drifted_attrs: ["SW_COURSE_NAME", "SW_REFERRAL_URL"] }
//     ],
//     applied_count: 0,                      // apply mode: re-upsert successes
//     errors: 0,
//     error_messages: [...],
//     ran_at: "..."
//   }

import postgres from "npm:postgres@3";
import {
  buildLearnerBrevoAttributes,
  buildLearnerBrevoAttributesNoMatch,
  type ProviderRow,
  type SubmissionRow,
  upsertLearnerInBrevo,
  upsertLearnerInBrevoNoMatch,
} from "../_shared/route-lead.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) throw new Error("SUPABASE_DB_URL not set");
const BREVO_API_KEY = Deno.env.get("BREVO_API_KEY");
if (!BREVO_API_KEY) throw new Error("BREVO_API_KEY not set in Edge Function env");

// Pool size 8: dry-run does ~6 SQL queries per contact (loadSubmissionByEmail
// + loadEmailAggregateState's 4 selects + crm.enrolments). With 200 contacts
// at max:1 sequential we'd burn ~50s — beyond Netlify's 26s Server Action
// cap. Pool of 8 + Promise.all on each Brevo page (100 contacts) brings the
// dry-run inside the cap. Reads only, no write contention concern.
const sql = postgres(DATABASE_URL, { max: 8, idle_timeout: 20, prepare: false });

const BREVO_BASE = "https://api.brevo.com/v3";
const BATCH_SIZE = 100;
// 250ms inter-write delay during apply: mirrors admin-brevo-resync and
// 024's pacing post the 2026-05-10 lead #370 contention incident. ~4
// writes/sec leaves headroom below Brevo's 10 req/s ceiling for any
// concurrent route-lead.ts upserts firing on live submissions.
const INTER_WRITE_DELAY_MS = 250;
const HALT_ERROR_RATE = 0.05;
// Drift list cap. Raised 50 → 5000 (2026-05-31) so a dry-run check returns
// EVERY drifting submission id, not a 50-row sample. The panel's chunked apply
// uses drift_list as its work queue, so it must be complete. 5000 is a safety
// ceiling far above any real audience at pilot scale.
const DRIFT_LIST_CAP = 5000;
// Apply-by-ids chunk ceiling. The panel sends drifting submission ids back in
// small batches and loops until done. Each call must finish inside Netlify's
// ~26s Server Action window: ~25 ids × (250ms throttle + ~400ms Brevo upsert)
// ≈ 16s, comfortable headroom. Calls above this are rejected so nothing can
// accidentally trigger a too-long synchronous run. Replaces the old
// async-apply-then-poll flow that hung ("still running after 180s") because the
// single waitUntil task exceeded the runtime ceiling before writing its result
// row. (2026-05-31)
const APPLY_IDS_MAX_PER_CALL = 25; // hard ceiling; the panel chunks at 10 (matched contacts are slow — see panel CHUNK comment)

interface BrevoContact {
  id: number;
  email: string;
  emailBlacklisted: boolean;
  attributes?: Record<string, unknown>;
}

interface BrevoListResp {
  contacts: BrevoContact[];
  count: number;
}

interface DriftEntry {
  email: string;
  submission_id: number;
  mode: "matched" | "no_match" | "pending";
  drifted_attrs: string[];
}

interface RunSummary {
  mode: "dry_run" | "apply";
  audience_size: number;
  processed: number;
  contacts_with_drift: number;
  contacts_aligned: number;
  skipped_no_submission: number;
  skipped_no_email: number;
  per_attribute_drift: Record<string, number>;
  drift_list: DriftEntry[];
  applied_count: number;
  errors: number;
  error_messages: string[];
  ran_at: string;
}

async function getAuditSharedSecret(): Promise<string> {
  const rows = await sql<Array<{ secret: string }>>`
    SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
  `;
  const secret = rows[0]?.secret;
  if (!secret) throw new Error("AUDIT_SHARED_SECRET not in vault");
  return secret;
}

async function listBrevoContacts(offset: number): Promise<BrevoContact[]> {
  const url = `${BREVO_BASE}/contacts?limit=${BATCH_SIZE}&offset=${offset}&sort=asc`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "api-key": BREVO_API_KEY!, accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Brevo list contacts ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as BrevoListResp;
  return Array.isArray(data.contacts) ? data.contacts : [];
}

// Look up the most-recent non-archived submission for a Brevo contact email.
// Matches admin-brevo-resync's logic of "pick the submission row that drives
// the contact" — most recent by submitted_at. SubmissionRow column list
// mirrors fetchSubmission inside routeLead.
async function loadSubmissionByEmail(email: string): Promise<SubmissionRow | null> {
  const rows = await sql<SubmissionRow[]>`
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
     WHERE lower(email) = lower(${email})
       AND archived_at IS NULL
     ORDER BY submitted_at DESC
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function loadProvider(providerId: string): Promise<ProviderRow | null> {
  const rows = await sql<ProviderRow[]>`
    SELECT provider_id, company_name, contact_email, contact_name,
           sheet_id, sheet_webhook_url, cc_emails,
           active, archived_at, auto_route_enabled,
           trust_line, regions, regional_contacts
      FROM crm.providers
     WHERE provider_id = ${providerId}
  `;
  return rows[0] ?? null;
}

// Load a submission by id (apply-by-ids path). Same column list as
// loadSubmissionByEmail. Does NOT filter archived in SQL — the apply loop
// decides (it skips archived rows), mirroring admin-brevo-resync.
async function loadSubmissionById(id: number): Promise<SubmissionRow | null> {
  const rows = await sql<SubmissionRow[]>`
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
     WHERE id = ${id}
  `;
  return rows[0] ?? null;
}

// Normalise both sides of an attribute comparison to the same string shape
// so we don't false-positive on type-vs-string mismatches.
//   - null / undefined → ""
//   - boolean → "true" / "false"
//   - number → String(n)
//   - string → trimmed
//
// The trim is load-bearing, not cosmetic. Brevo trims leading/trailing
// whitespace when it STORES a contact attribute, but the canonical projection
// pushes the raw DB value. Our DB carries trailing spaces on many names
// ("Obinna ", "Chloe ") and a deliberate leading space on phones
// (" 07827492172" — the Netlify numeric-coercion guard, see
// feedback_netlify_forms_numeric_coercion). So desired=" 07827492172" vs
// Brevo-stored="07827492172" was flagging as permanent drift that re-applying
// could never fix (Brevo just re-trims). Trimming both sides here collapses
// only whitespace-only differences; a genuine value change ("Smith" vs
// "Jones") still drifts. Fixed 2026-05-31 — was the bulk of a stuck 110-142
// drift count (SW_PHONE 67 + FIRSTNAME 27 + LASTNAME 21). The comment always
// said "trimmed"; the code never did.
function normaliseForCompare(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.trim();
  return String(v).trim();
}

// Brevo Category attributes are an asymmetric pain. GET /contacts (list)
// returns Category values as the numeric position in the enumeration (1, 2,
// 3...). GET /contacts/{email} (single) returns them as the label string
// (e.g. "matched"). The canonical projection writes labels. Comparing the
// list-endpoint number against the label string is always a false-positive
// drift. Translate list-side numbers to labels using the attribute
// definitions before comparing.
//
// Charlotte hit this 2026-05-22: SW_MATCH_STATUS drift count stuck at 304/304
// despite contacts actually holding the correct label. The reconciler was
// reading "1" / "2" / "3" and comparing against "matched" / "pending" /
// "no_match".
type CategoryAttrMap = Map<string, Map<number, string>>;

async function loadCategoryAttrMap(): Promise<CategoryAttrMap> {
  const map: CategoryAttrMap = new Map();
  try {
    const res = await fetch(`${BREVO_BASE}/contacts/attributes`, {
      method: "GET",
      headers: { "api-key": BREVO_API_KEY!, accept: "application/json" },
    });
    if (!res.ok) {
      console.warn(`Brevo list attributes ${res.status}: ${await res.text()}`);
      return map;
    }
    const data = await res.json() as {
      attributes?: Array<{
        name?: string;
        type?: string;
        category?: string;
        enumeration?: Array<{ value?: unknown; label?: unknown }>;
      }>;
    };
    for (const attr of data.attributes ?? []) {
      const isCategory = (attr.type ?? "").toLowerCase() === "category"
        || (attr.category ?? "").toLowerCase() === "category";
      if (!isCategory) continue;
      const name = attr.name;
      if (typeof name !== "string") continue;
      const enumeration = Array.isArray(attr.enumeration) ? attr.enumeration : [];
      const positionToLabel = new Map<number, string>();
      for (const item of enumeration) {
        const pos = typeof item.value === "number"
          ? item.value
          : typeof item.value === "string" && /^\d+$/.test(item.value)
          ? Number(item.value)
          : NaN;
        const label = typeof item.label === "string" ? item.label : null;
        if (!Number.isFinite(pos) || !label) continue;
        positionToLabel.set(pos, label);
      }
      if (positionToLabel.size > 0) map.set(name, positionToLabel);
    }
  } catch (err) {
    console.warn("loadCategoryAttrMap failed:", err instanceof Error ? err.message : String(err));
  }
  return map;
}

function translateBrevoCategoryValue(
  key: string,
  raw: unknown,
  categoryMap: CategoryAttrMap,
): unknown {
  const positions = categoryMap.get(key);
  if (!positions) return raw;
  const n = typeof raw === "number"
    ? raw
    : typeof raw === "string" && /^\d+$/.test(raw)
    ? Number(raw)
    : NaN;
  if (!Number.isFinite(n)) return raw;
  return positions.get(n) ?? raw;
}

function diffAttributes(
  desired: Record<string, unknown>,
  current: Record<string, unknown> | undefined,
  categoryMap: CategoryAttrMap,
): string[] {
  const drifted: string[] = [];
  for (const key of Object.keys(desired)) {
    const want = normaliseForCompare(desired[key]);
    const rawHave = current?.[key];
    const translatedHave = translateBrevoCategoryValue(key, rawHave, categoryMap);
    const have = normaliseForCompare(translatedHave);
    if (want !== have) drifted.push(key);
  }
  return drifted;
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

// Per-contact evaluation result. Pass 1 produces these in parallel; pass 2
// (apply only) re-upserts drift entries sequentially with rate-limit throttling.
type Evaluation =
  | { kind: "skipped_no_email"; contact: BrevoContact }
  | { kind: "skipped_no_submission"; contact: BrevoContact }
  | { kind: "error"; contact: BrevoContact; message: string }
  | { kind: "aligned"; contact: BrevoContact; submission: SubmissionRow; mode: "matched" | "no_match" | "pending" }
  | {
      kind: "drift";
      contact: BrevoContact;
      submission: SubmissionRow;
      mode: "matched" | "no_match" | "pending";
      provider: ProviderRow | null;
      drifted_attrs: string[];
    };

async function run(apply: boolean): Promise<RunSummary> {
  const startedAt = new Date();

  // Load Brevo Category attribute definitions once per run so we can
  // translate list-endpoint numeric values to label strings during the diff.
  // See loadCategoryAttrMap comment for the asymmetry this works around.
  const categoryMap = await loadCategoryAttrMap();

  // Cache providers we've loaded this run; provider rows rarely change and
  // the pilot has <10 providers — reload-once-per-run keeps the SQL count
  // bounded without staleness risk inside a single ~minute-long run.
  const providerCache = new Map<string, ProviderRow | null>();
  async function getProvider(id: string): Promise<ProviderRow | null> {
    if (providerCache.has(id)) return providerCache.get(id) ?? null;
    const row = await loadProvider(id);
    providerCache.set(id, row);
    return row;
  }

  async function evaluateContact(contact: BrevoContact): Promise<Evaluation> {
    if (!contact.email) return { kind: "skipped_no_email", contact };
    const submission = await loadSubmissionByEmail(contact.email);
    if (!submission) return { kind: "skipped_no_submission", contact };

    // Mirrors admin-brevo-resync's branching:
    //   is_dq → no_match
    //   !primary_routed_to → pending
    //   else matched (need provider row)
    let mode: "matched" | "no_match" | "pending";
    let desired: Record<string, unknown>;
    let provider: ProviderRow | null = null;

    try {
      if (submission.is_dq) {
        mode = "no_match";
        desired = await buildLearnerBrevoAttributesNoMatch(sql, submission, "no_match");
      } else if (!submission.primary_routed_to) {
        mode = "pending";
        desired = await buildLearnerBrevoAttributesNoMatch(sql, submission, "pending");
      } else {
        provider = await getProvider(submission.primary_routed_to);
        if (!provider) {
          return { kind: "error", contact, message: `provider ${submission.primary_routed_to} not found` };
        }
        // Only ARCHIVED providers gate reconcile — paused (active=false but
        // not archived, e.g. Courses Direct / WYK between intakes) is fine.
        // A reconcile rebuilds attributes on EXISTING learner contacts; it
        // doesn't route a new lead. `active` is a routing concern. This
        // mirrors admin-brevo-resync's gate exactly (which is why those CD/WYK
        // leads resync fine there but errored here). Before this change ~52
        // paused-provider leads errored every daily run and could never be
        // reconciled. (2026-05-31)
        if (provider.archived_at) {
          return { kind: "error", contact, message: `provider ${submission.primary_routed_to} archived` };
        }
        mode = "matched";
        desired = await buildLearnerBrevoAttributes(sql, provider, submission);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: "error", contact, message: `build desired attrs failed: ${msg}` };
    }

    const drifted_attrs = diffAttributes(desired, contact.attributes, categoryMap);
    if (drifted_attrs.length === 0) {
      return { kind: "aligned", contact, submission, mode };
    }
    return { kind: "drift", contact, submission, mode, provider, drifted_attrs };
  }

  // Pass 1 — walk Brevo + evaluate in parallel within each page. Read-only,
  // SQL pool of 8 absorbs the concurrent SELECTs. Sized to finish ~200
  // contacts well inside the Netlify Server Action cap.
  const evaluations: Evaluation[] = [];
  let offset = 0;

  while (true) {
    const batch = await listBrevoContacts(offset);
    if (batch.length === 0) break;
    const results = await Promise.all(batch.map(evaluateContact));
    evaluations.push(...results);
    if (batch.length < BATCH_SIZE) break;
    offset += batch.length;
  }

  // Tally
  let processed = 0;
  let aligned = 0;
  let drifted = 0;
  let skippedNoSub = 0;
  let skippedNoEmail = 0;
  let errors = 0;
  const errorMessages: string[] = [];
  const perAttribute: Record<string, number> = {};
  const driftList: DriftEntry[] = [];

  for (const e of evaluations) {
    processed++;
    switch (e.kind) {
      case "skipped_no_email":
        skippedNoEmail++;
        break;
      case "skipped_no_submission":
        skippedNoSub++;
        break;
      case "error":
        errors++;
        errorMessages.push(`${e.contact.email}: ${e.message}`);
        break;
      case "aligned":
        aligned++;
        break;
      case "drift":
        drifted++;
        for (const k of e.drifted_attrs) perAttribute[k] = (perAttribute[k] ?? 0) + 1;
        if (driftList.length < DRIFT_LIST_CAP) {
          driftList.push({
            email: e.contact.email,
            submission_id: e.submission.id,
            mode: e.mode,
            drifted_attrs: e.drifted_attrs,
          });
        }
        break;
    }
  }

  // Pass 2 (apply only) — re-fire canonical upsert sequentially for every
  // drift entry. Throttled to stay under Brevo's 10 req/s ceiling while
  // leaving headroom for any concurrent route-lead.ts upserts.
  let appliedOk = 0;
  if (apply) {
    const drifts = evaluations.filter((e): e is Extract<Evaluation, { kind: "drift" }> => e.kind === "drift");
    let batchErrors = 0;
    for (let i = 0; i < drifts.length; i++) {
      const d = drifts[i];
      if (i > 0) await sleep(INTER_WRITE_DELAY_MS);
      try {
        if (d.mode === "matched") {
          if (!d.provider) throw new Error("provider missing on drift entry");
          const r = await upsertLearnerInBrevo(sql, d.provider, d.submission);
          if (!r.ok) throw new Error(r.error ?? "unknown");
        } else {
          const r = await upsertLearnerInBrevoNoMatch(sql, d.submission.id, d.mode);
          if (!r.ok) throw new Error(r.error ?? "unknown");
        }
        appliedOk++;
      } catch (err) {
        errors++;
        batchErrors++;
        const msg = `${d.contact.email} resync (${d.mode}): ${err instanceof Error ? err.message : String(err)}`;
        errorMessages.push(msg);
        console.error("[error]", msg);
      }
    }
    const errorRate = drifts.length > 0 ? batchErrors / drifts.length : 0;
    if (errorRate > HALT_ERROR_RATE) {
      console.error(`HALT signal — apply error rate ${(errorRate * 100).toFixed(2)}% exceeds threshold`);
    }
  }

  return {
    mode: apply ? "apply" : "dry_run",
    audience_size: processed,
    processed,
    contacts_with_drift: drifted,
    contacts_aligned: aligned,
    skipped_no_submission: skippedNoSub,
    skipped_no_email: skippedNoEmail,
    per_attribute_drift: perAttribute,
    drift_list: driftList,
    applied_count: appliedOk,
    errors,
    error_messages: errorMessages,
    ran_at: startedAt.toISOString(),
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

  let body: { apply?: unknown; log_drift?: unknown; async_apply?: unknown; async_check?: unknown; list_attributes?: unknown; apply_ids?: unknown };
  try {
    body = await req.json() as { apply?: unknown; log_drift?: unknown; async_apply?: unknown; async_check?: unknown; list_attributes?: unknown; apply_ids?: unknown };
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const apply = body.apply === true;
  const logDrift = body.log_drift === true;
  const asyncApply = body.async_apply === true;
  const asyncCheck = body.async_check === true;

  // Apply-by-ids (synchronous, chunked). The reliable replacement for the old
  // full-walk async apply that hung. The panel runs a dry-run check first
  // (drift_list now returns every drifting submission id), then sends those
  // ids back in chunks of ≤ APPLY_IDS_MAX_PER_CALL, looping until done. Each
  // call resyncs its ids via the canonical upsert path (identical branching to
  // admin-brevo-resync), finishes inside the Server Action window, and returns
  // a real result immediately. No background task, no dead_letter polling.
  if (Array.isArray(body.apply_ids)) {
    // Accept numbers AND numeric strings. drift_list's submission_id originates
    // from a bigint column, which postgres@3 returns as a JS string ("216"),
    // and it survives the JSON round-trip as a string. A number-only filter
    // dropped every id → empty array → "must be a non-empty array" error. See
    // memory: postgres@3 returns bigint as JS string. (2026-05-31)
    const ids = (body.apply_ids as unknown[])
      .map((v) => (typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v, 10) : NaN))
      .filter((n): n is number => Number.isInteger(n));
    if (ids.length === 0) {
      return json({ ok: false, error: "apply_ids must be a non-empty array of integers" }, 400);
    }
    if (ids.length > APPLY_IDS_MAX_PER_CALL) {
      return json({
        ok: false,
        error: `apply_ids capped at ${APPLY_IDS_MAX_PER_CALL} per call (got ${ids.length}); the panel chunks automatically`,
      }, 400);
    }

    const results: Array<{ id: number; status: "ok" | "skipped" | "error"; reason?: string }> = [];
    let appliedOk = 0;
    let errors = 0;
    const errorMessages: string[] = [];
    const providerCache = new Map<string, ProviderRow | null>();

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (i > 0) await sleep(INTER_WRITE_DELAY_MS);
      try {
        const submission = await loadSubmissionById(id);
        if (!submission) { results.push({ id, status: "skipped", reason: "not found" }); continue; }
        if (submission.archived_at) { results.push({ id, status: "skipped", reason: "archived" }); continue; }

        if (submission.is_dq) {
          const r = await upsertLearnerInBrevoNoMatch(sql, id, "no_match");
          if (!r.ok) throw new Error(r.error ?? "unknown");
        } else if (!submission.primary_routed_to) {
          const r = await upsertLearnerInBrevoNoMatch(sql, id, "pending");
          if (!r.ok) throw new Error(r.error ?? "unknown");
        } else {
          let provider = providerCache.get(submission.primary_routed_to);
          if (provider === undefined) {
            provider = await loadProvider(submission.primary_routed_to);
            providerCache.set(submission.primary_routed_to, provider);
          }
          if (!provider) { results.push({ id, status: "error", reason: "provider not found" }); errors++; continue; }
          // Only archived providers gate apply — paused is fine (mirrors the
          // dry-run gate + admin-brevo-resync).
          if (provider.archived_at) { results.push({ id, status: "skipped", reason: "provider archived" }); continue; }
          const r = await upsertLearnerInBrevo(sql, provider, submission);
          if (!r.ok) throw new Error(r.error ?? "unknown");
        }
        appliedOk++;
        results.push({ id, status: "ok" });
      } catch (err) {
        errors++;
        const msg = `#${id}: ${err instanceof Error ? err.message : String(err)}`;
        errorMessages.push(msg);
        results.push({ id, status: "error", reason: msg });
        console.error("[apply_ids]", msg);
      }
    }

    return json({
      ok: true,
      mode: "apply_ids",
      requested: ids.length,
      applied: appliedOk,
      errors,
      error_messages: errorMessages,
      results,
    });
  }

  // Diagnostic: list every attribute currently defined in the Brevo account
  // so the reconciler can cross-check whether the canonical projection's
  // attribute names exist. Brevo silently drops writes to undefined
  // attributes — the symptom Charlotte hit 2026-05-22 where SW_MATCH_STATUS
  // and SW_PROVIDER_REP_FIRST_NAME drift counts didn't move after apply.
  if (body.list_attributes === true) {
    try {
      const res = await fetch(`${BREVO_BASE}/contacts/attributes`, {
        method: "GET",
        headers: { "api-key": BREVO_API_KEY!, accept: "application/json" },
      });
      if (!res.ok) {
        return json({ ok: false, error: `Brevo GET attributes ${res.status}: ${await res.text()}` }, 500);
      }
      const data = await res.json() as { attributes?: Array<{ name?: string; category?: string; type?: string; enumeration?: unknown }> };
      const attrs = (data.attributes ?? []).map((a) => ({
        name: a.name,
        category: a.category,
        type: a.type,
      }));
      return json({ ok: true, count: attrs.length, attributes: attrs });
    } catch (err) {
      return json({ ok: false, error: `list_attributes failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  }

  // Background runner: shared between async_apply (apply: true) and
  // async_check (apply: false). Both blow past Netlify's 26s Server Action
  // cap at production volumes — apply because of the 250ms × N inter-write
  // delay (75s+ for 300 drift), check because each of N contacts triggers
  // ~6 sequential SQL queries plus a paginated Brevo list (10-30s for 200+
  // contacts). EdgeRuntime.waitUntil lets the EF return immediately and
  // finish on Supabase. UI re-checks via dead_letter for the result row.
  if ((apply && asyncApply) || (!apply && asyncCheck)) {
    const startedAt = new Date().toISOString();
    const resultSource = apply
      ? "brevo_attribute_reconcile_async_result"
      : "brevo_attribute_reconcile_async_check_result";
    const task = (async () => {
      try {
        const summary = await run(apply);
        await sql.begin(async (trx) => {
          await trx`SET LOCAL ROLE functions_writer`;
          // Auto-resolve this source's prior rows so the async result log holds
          // only the latest run, never an accumulating pile (ticket e2b2615f).
          await trx`
            UPDATE leads.dead_letter SET replayed_at = now()
             WHERE source = ${resultSource} AND replayed_at IS NULL
          `;
          await trx`
            INSERT INTO leads.dead_letter (source, raw_payload, error_context)
            VALUES (
              ${resultSource},
              ${sql.json({
                started_at: startedAt,
                ran_at: summary.ran_at,
                applied_count: summary.applied_count,
                errors: summary.errors,
                contacts_with_drift: summary.contacts_with_drift,
                contacts_aligned: summary.contacts_aligned,
                processed: summary.processed,
                per_attribute_drift: summary.per_attribute_drift,
                drift_list: summary.drift_list,
                error_messages: summary.error_messages.slice(0, 20),
              })},
              ${apply
                ? `Brevo async re-sync complete: ${summary.applied_count} contact${summary.applied_count === 1 ? "" : "s"} updated, ${summary.errors} error${summary.errors === 1 ? "" : "s"}.`
                : `Brevo async drift check complete: ${summary.contacts_with_drift} of ${summary.processed} drift, ${summary.errors} error${summary.errors === 1 ? "" : "s"}.`}
            )
          `;
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${apply ? "async_apply" : "async_check"}] run failed:`, msg);
        try {
          await sql.begin(async (trx) => {
            await trx`SET LOCAL ROLE functions_writer`;
            await trx`
              INSERT INTO leads.dead_letter (source, raw_payload, error_context)
              VALUES (
                ${resultSource},
                ${sql.json({ started_at: startedAt, error: msg })},
                ${apply
                  ? `Brevo async re-sync failed: ${msg}`
                  : `Brevo async drift check failed: ${msg}`}
              )
            `;
          });
        } catch (logErr) {
          console.error(`[${apply ? "async_apply" : "async_check"}] result log failed:`, String(logErr));
        }
      }
    })();
    // @ts-ignore — EdgeRuntime.waitUntil is provided by Supabase Edge Runtime.
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      // @ts-ignore — same.
      EdgeRuntime.waitUntil(task);
    } else {
      // Local dev fallback — fire and forget.
      task.catch((err) => console.error(`[${apply ? "async_apply" : "async_check"}] task failed:`, err));
    }
    return json({
      ok: true,
      started: true,
      async: true,
      mode: apply ? "apply" : "dry_run",
      started_at: startedAt,
      note: apply
        ? "Re-sync running in background. Re-check drift in ~2 minutes."
        : "Drift check running in background. Re-run in ~1 minute to see the result.",
    });
  }

  try {
    const summary = await run(apply);

    // Daily cron uses log_drift=true so /admin/errors can show a status pill
    // and the digest can pick up the drift summary. Only writes when there's
    // something to report — clean runs leave no row, the pill defaults to
    // Aligned in their absence.
    if (!apply && logDrift) {
      try {
        await sql.begin(async (trx) => {
          await trx`SET LOCAL ROLE functions_writer`;
          // Auto-resolve prior daily-drift summaries first, so a run that finds
          // zero drift clears the old signal and the table holds at most the
          // latest run's summary, not weeks of stale rows (ticket e2b2615f).
          await trx`
            UPDATE leads.dead_letter SET replayed_at = now()
             WHERE source = 'brevo_attribute_drift' AND replayed_at IS NULL
          `;
          if (summary.contacts_with_drift > 0) {
            await trx`
              INSERT INTO leads.dead_letter (source, raw_payload, error_context)
              VALUES (
                'brevo_attribute_drift',
                ${sql.json({
                  contacts_with_drift: summary.contacts_with_drift,
                  processed: summary.processed,
                  per_attribute_drift: summary.per_attribute_drift,
                  ran_at: summary.ran_at,
                })},
                ${`Brevo attribute reconcile (daily dry-run): ${summary.contacts_with_drift} of ${summary.processed} contacts drift from canonical projection. Run apply via /admin/errors → DB ↔ Brevo → Re-sync.`}
              )
            `;
          }
        });
      } catch (logErr) {
        console.error("brevo drift dead_letter log failed:", String(logErr));
      }
    }

    return json({ ok: true, ...summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("reconcile failed:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});
