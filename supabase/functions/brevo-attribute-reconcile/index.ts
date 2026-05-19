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
// Body: { "apply": boolean }
//   apply=false → dry-run, no writes, returns the diff
//   apply=true  → re-runs upsertLearnerInBrevo / upsertLearnerInBrevoNoMatch
//                 for every drifted contact via the canonical path
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
const DRIFT_LIST_CAP = 50;

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

// Normalise both sides of an attribute comparison to the same string shape
// so we don't false-positive on type-vs-string mismatches.
//   - null / undefined → ""
//   - boolean → "true" / "false"
//   - number → String(n)
//   - string → as-is, trimmed
function normaliseForCompare(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return String(v);
}

function diffAttributes(
  desired: Record<string, unknown>,
  current: Record<string, unknown> | undefined,
): string[] {
  const drifted: string[] = [];
  for (const key of Object.keys(desired)) {
    const want = normaliseForCompare(desired[key]);
    const have = normaliseForCompare(current?.[key]);
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
        if (!provider.active || provider.archived_at) {
          return { kind: "error", contact, message: `provider ${submission.primary_routed_to} inactive/archived` };
        }
        mode = "matched";
        desired = await buildLearnerBrevoAttributes(sql, provider, submission);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: "error", contact, message: `build desired attrs failed: ${msg}` };
    }

    const drifted_attrs = diffAttributes(desired, contact.attributes);
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

  let body: { apply?: unknown };
  try {
    body = await req.json() as { apply?: unknown };
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const apply = body.apply === true;

  try {
    const summary = await run(apply);
    return json({ ok: true, ...summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("reconcile failed:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});
