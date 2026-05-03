// Shared ingestion pipeline for form submissions.
//
// Two Edge Functions write to leads.submissions:
//   - netlify-lead-router   - receives Netlify's outgoing webhook (the fast path)
//   - netlify-leads-reconcile - hourly cross-check of Netlify's submission store,
//                               back-fills anything the webhook failed to deliver
//
// Both must produce identical rows for the same Netlify payload, or we get drift
// between what the webhook captured and what reconcile back-fills. This module
// is that single source of truth: given a Netlify-shaped payload, produce the
// canonical row; insert with idempotency against migration 0010's unique index.
//
// See platform/docs/changelog.md 2026-04-21 Session 3.3 for the architectural
// reasoning (why reconcile exists, why the logic is shared rather than duplicated).

import type postgres from "npm:postgres@3";

// deno-lint-ignore no-explicit-any
type Sql = any; // postgres.Sql at runtime; typed loosely here to avoid
                // leaking a heavy generic across function boundaries.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface CanonicalSubmission {
  schema_version: string;
  submitted_at: string;
  page_url: string | null;
  course_id: string | null;
  provider_ids: string[];
  region_scheme: string | null;
  funding_category: string | null;
  funding_route: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  fbclid: string | null;
  gclid: string | null;
  referrer: string | null;

  // Funded-shape learner fields
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  la: string | null;
  age_band: string | null;
  employment_status: string | null;
  prior_level_3_or_higher: boolean | null;
  can_start_on_intake_date: boolean | null;
  outcome_interest: string | null;
  why_this_course: string | null;

  // Cohort-intake fields (lead payload schema 1.2, migration 0041). Set by
  // multi-cohort funded pages; NULL on rolling-intake and pre-1.2 forms.
  preferred_intake_id: string | null;
  acceptable_intake_ids: string[];

  // Self-funded-shape learner fields (schema 1.1, Session 5). Any form may
  // send these; they simply carry null on funded submissions that don't
  // collect them. WYK's LIFT funded form collects `postcode` for the borough
  // gate; that value lands here too.
  postcode: string | null;
  region: string | null; // populated by router via reference.postcodes JOIN in Session 5.1; NULL in the interim
  reason: string | null;
  interest: string | null;
  situation: string | null;
  qualification: string | null;
  start_when: string | null;
  budget: string | null;
  courses_selected: string[];

  terms_accepted: boolean;
  marketing_opt_in: boolean;
  is_dq: boolean;
  dq_reason: string | null;
  session_id: string | null;

  // A/B experiment attribution (platform migration 0061). Set when the
  // submission came from a page running an experiment; both NULL otherwise.
  // Variant is "a" (canonical / control) or "b" (challenger). Populated from
  // the form's hidden inputs which are baked in per-variant at site build
  // time. See switchable/site/docs/funded-funnel-architecture.md.
  experiment_id: string | null;
  experiment_variant: string | null;

  raw_payload: JsonValue;
  archived_at: string | null;
}

export interface InsertResult {
  id: number;
  /**
   * True when the row was already present (matched the Netlify-id unique index
   * from migration 0010). The existing id is returned so callers can still act
   * on it (or, for reconcile, log that it was already covered).
   */
  duplicate: boolean;
  /**
   * Set when this submission was detected as a re-application of a prior
   * submission with the same email + course_id (within a 90-day window, not
   * archived). NULL on first-time submissions and on duplicates (where we
   * didn't insert).
   *
   * Lead-router uses this to skip auto-routing re-applications and send a
   * "they reapplied" notification to the provider instead of a fresh routing.
   * Added migration 0026.
   */
  parentSubmissionId: number | null;
  /**
   * The parent's `primary_routed_to` value at the moment of re-application,
   * or NULL if no parent or parent wasn't routed yet.
   * Lead-router uses this to decide whether the candidate provider matches
   * the parent's existing routing (Case 1: re-engagement) or differs (Case 2:
   * new routing event for a different provider).
   */
  parentPrimaryRoutedTo: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Owner-controlled email domains. Submissions with an email matching any of
// these get DQ'd with dq_reason='owner_test_submission', empty provider_ids,
// and archived_at set at insert so they drop out of every active-lead view.
// Exact-domain match only (no subdomain match).
const OWNER_TEST_DOMAINS = [
  "switchable.org.uk",
  "switchable.careers",
  "switchable.com",
  "switchleads.co.uk",
];

// Dummy / placeholder domains common in test submissions (owner typing without
// an owner-allowlisted email, bots, scrapers). Same DQ behaviour as owner tests
// but tagged dq_reason='dummy_test_email' so audit queries can separate
// deliberate owner tests from inadvertent test emails. Added 2026-04-22 after
// id 30 (test7@testing.com) slipped past the owner allowlist and reached EMS.
const DUMMY_TEST_DOMAINS = [
  "example.com",
  "example.org",
  "example.net",
  "test.com",
  "testing.com",
];

// Owner personal emails used for GTM/form testing, where the domain belongs
// to a public provider (iCloud, Gmail, etc.) and cannot be blanket-matched.
// Exact email match, case-insensitive. Storage is lowercase.
const OWNER_TEST_EMAILS = [
  "charliemarieharris@icloud.com",
];

// ---- public entry points ----

/**
 * Normalise a Netlify-shaped payload and apply owner-test overrides in one step.
 * Router and reconcile both call this to produce the canonical row.
 */
export function normaliseAndOverride(
  formName: string,
  body: Record<string, JsonValue>,
  rawPayload: JsonValue,
): CanonicalSubmission {
  return applyDqOverride(applyOwnerTestOverrides(normalise(formName, body, rawPayload)));
}

/**
 * Defence-in-depth for client-flagged DQ submissions.
 *
 * When the form sends a `dq_reason` hidden field (e.g. self-funded DQ panel
 * "keep me on the list" path), the per-form normaliser still populates
 * provider_ids from its hardcoded fallback (e.g. ['courses-direct']). The
 * Edge Function's routing branch already short-circuits on is_dq=true, so
 * routing doesn't fire, but the row in the DB carries provider_ids that
 * make the lead look like it was a candidate for that provider. Misleading.
 *
 * Force provider_ids = [] whenever the row is flagged is_dq=true. Mirrors
 * applyOwnerTestOverrides which already does this for owner-test emails.
 */
function applyDqOverride(row: CanonicalSubmission): CanonicalSubmission {
  if (!row.is_dq || row.provider_ids.length === 0) return row;
  return { ...row, provider_ids: [] };
}

/**
 * Insert a canonical row into leads.submissions with idempotency.
 *
 * If a row already exists for the same Netlify submission id (raw_payload.id),
 * the existing id is returned with duplicate=true and no write occurs. This
 * matches the unique partial index from migration 0010.
 *
 * On insert, a matching leads.partials row (by session_id) is marked complete
 * so the funnel-dropoff view treats it as converted.
 *
 * Caller is responsible for wrapping in its own try/catch for transport errors.
 */
export async function insertSubmission(
  sql: Sql,
  row: CanonicalSubmission,
): Promise<InsertResult> {
  return await sql.begin(async (trx: Sql) => {
    await trx`SET LOCAL ROLE functions_writer`;

    // Parent lookup (lead dedup v1, migration 0026). Match by lower(email) +
    // course_id within the last 90 days, excluding archived rows. Earliest
    // match wins (chains back to the original parent, not an intermediate
    // re-application). Skip the lookup entirely when email is missing.
    let parentSubmissionId: number | null = null;
    let parentPrimaryRoutedTo: string | null = null;
    if (row.email) {
      const [parent] = await trx<Array<{ id: number; primary_routed_to: string | null }>>`
        SELECT id, primary_routed_to
          FROM leads.submissions
         WHERE LOWER(email) = LOWER(${row.email})
           AND course_id IS NOT DISTINCT FROM ${row.course_id}
           AND archived_at IS NULL
           AND submitted_at > now() - INTERVAL '90 days'
           AND parent_submission_id IS NULL
         ORDER BY submitted_at ASC
         LIMIT 1
      `;
      if (parent) {
        parentSubmissionId = Number(parent.id);
        parentPrimaryRoutedTo = parent.primary_routed_to;
      }
    }

    const inserted = await trx<Array<{ id: number }>>`
      INSERT INTO leads.submissions (
        schema_version, submitted_at, page_url, course_id, provider_ids,
        region_scheme, funding_category, funding_route,
        utm_source, utm_medium, utm_campaign, utm_content,
        fbclid, gclid, referrer,
        first_name, last_name, email, phone, la, age_band,
        employment_status, prior_level_3_or_higher, can_start_on_intake_date,
        outcome_interest, why_this_course,
        preferred_intake_id, acceptable_intake_ids,
        postcode, region, reason, interest, situation, qualification,
        start_when, budget, courses_selected,
        terms_accepted, marketing_opt_in,
        is_dq, dq_reason, session_id,
        experiment_id, experiment_variant,
        raw_payload, archived_at,
        parent_submission_id
      ) VALUES (
        ${row.schema_version}, ${row.submitted_at}, ${row.page_url}, ${row.course_id}, ${row.provider_ids},
        ${row.region_scheme}, ${row.funding_category}, ${row.funding_route},
        ${row.utm_source}, ${row.utm_medium}, ${row.utm_campaign}, ${row.utm_content},
        ${row.fbclid}, ${row.gclid}, ${row.referrer},
        ${row.first_name}, ${row.last_name}, ${row.email}, ${row.phone}, ${row.la}, ${row.age_band},
        ${row.employment_status}, ${row.prior_level_3_or_higher}, ${row.can_start_on_intake_date},
        ${row.outcome_interest}, ${row.why_this_course},
        ${row.preferred_intake_id}, ${row.acceptable_intake_ids},
        ${row.postcode}, ${row.region}, ${row.reason}, ${row.interest}, ${row.situation}, ${row.qualification},
        ${row.start_when}, ${row.budget}, ${row.courses_selected},
        ${row.terms_accepted}, ${row.marketing_opt_in},
        ${row.is_dq}, ${row.dq_reason}, ${row.session_id},
        ${row.experiment_id}, ${row.experiment_variant},
        ${trx.json(row.raw_payload)}, ${row.archived_at},
        ${parentSubmissionId}
      )
      ON CONFLICT ((raw_payload->>'id')) WHERE raw_payload->>'id' IS NOT NULL DO NOTHING
      RETURNING id
    `;

    if (inserted.length > 0) {
      const newId = Number(inserted[0].id);
      if (row.session_id) {
        await trx`
          UPDATE leads.partials
             SET is_complete = true,
                 updated_at  = now()
           WHERE session_id  = ${row.session_id}
        `;
      }
      // Update parent's counters atomically with the child insert.
      // Waitlist-enrichment children don't count as re-applications — they're
      // the same submission with extra details added later, not a repeat
      // engagement. The dashboard's "Reapplied N×" badge fires only on real
      // re-applications. Linking via parent_submission_id still happens (so
      // the list view dedups), but the counter only increments for true
      // re-applications.
      if (parentSubmissionId !== null && row.dq_reason !== "waitlist_enrichment") {
        await trx`
          UPDATE leads.submissions
             SET re_submission_count   = re_submission_count + 1,
                 last_re_submission_at = ${row.submitted_at},
                 updated_at            = now()
           WHERE id = ${parentSubmissionId}
        `;
      }
      return {
        id: newId,
        duplicate: false,
        parentSubmissionId,
        parentPrimaryRoutedTo,
      };
    }

    // ON CONFLICT path: the Netlify id matched a row that already exists.
    // Look it up so the caller gets a stable id back.
    const netlifyId = readNetlifyId(row.raw_payload);
    if (!netlifyId) {
      throw new Error(
        "INSERT returned no id and raw_payload has no Netlify id; cannot resolve duplicate",
      );
    }
    const existing = await trx<Array<{ id: number }>>`
      SELECT id FROM leads.submissions
       WHERE raw_payload->>'id' = ${netlifyId}
       LIMIT 1
    `;
    if (existing.length === 0) {
      throw new Error(`ON CONFLICT fired but no row found with netlify id ${netlifyId}`);
    }
    return {
      id: Number(existing[0].id),
      duplicate: true,
      parentSubmissionId: null,
      parentPrimaryRoutedTo: null,
    };
  });
}

/**
 * Extract the Netlify submission id from a raw payload, if present.
 * Exposed for reconcile to cross-check without re-parsing.
 */
export function readNetlifyId(rawPayload: JsonValue): string | null {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return null;
  const v = (rawPayload as Record<string, JsonValue>)["id"];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// ---- internals ----

function normalise(
  formName: string,
  body: Record<string, JsonValue>,
  rawPayload: JsonValue,
): CanonicalSubmission {
  const data =
    body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? (body.data as Record<string, JsonValue>)
      : {};

  const pageUrl = firstString(data["page_url"], data["referrer"]);
  const dqReason = firstString(data["dq_reason"]);
  const dqFlag = toBool(data["dq"]);
  const clientSaysDq = dqFlag === true || dqReason !== null;

  const submittedAt = firstString(body["created_at"]) ?? new Date().toISOString();

  const base: CanonicalSubmission = {
    // Default matches what the switchable-* forms currently send as a
    // hidden input ("1.0"). Session 5 is a docs-only bump of the contract
    // to 1.1 - additive per .claude/rules/schema-versioning.md. The DB
    // column reflects the value the producer sent, which stays "1.0"
    // until a switchable/site deploy bumps the form's hidden input to
    // "1.1". Router behaviour is driven by form_name, not schema_version,
    // so mixed values on rows are expected and harmless.
    schema_version: firstString(data["schema_version"]) ?? "1.0",
    submitted_at: submittedAt,
    page_url: pageUrl,
    course_id: null,
    provider_ids: [],
    region_scheme: firstString(data["region_scheme"]),
    funding_category: firstString(data["funding_category"]),
    funding_route: firstString(data["funding_route"]),
    utm_source: firstString(data["utm_source"]),
    utm_medium: firstString(data["utm_medium"]),
    utm_campaign: firstString(data["utm_campaign"]),
    utm_content: firstString(data["utm_content"]),
    fbclid: firstString(data["fbclid"]),
    gclid: firstString(data["gclid"]),
    referrer: firstString(data["referrer"]),
    first_name: firstString(data["first_name"], body["first_name"]),
    last_name: firstString(data["last_name"], body["last_name"]),
    email: firstString(data["email"], body["email"]),
    phone: firstString(data["phone"]),
    la: firstString(data["la"], data["local_authority"]),
    age_band: firstString(data["age_band"], data["age"]),
    employment_status: firstString(data["employment_status"], data["employment"]),
    prior_level_3_or_higher: toBool(data["prior_level_3_or_higher"], data["prior_level_3"]),
    can_start_on_intake_date: toBool(
      data["can_start_on_intake_date"],
      data["can_start"],
      data["start_date"],
    ),
    outcome_interest: firstString(data["outcome_interest"], data["outcome"]),
    why_this_course: firstString(data["why_this_course"], data["why"]),

    // Schema 1.2 cohort fields. preferred_intake_id is a single string
    // (slug like "tv-may-06"). acceptable_intake_ids comes from a hidden
    // input as a CSV string OR as an array if Netlify groups duplicates;
    // parseStringArray handles both shapes.
    preferred_intake_id: firstString(data["preferred_intake_id"]),
    acceptable_intake_ids: parseStringArray(data["acceptable_intake_ids"]),

    // Self-funded canonical fields (schema 1.1). Read generically at the
    // base so any form shape (self-funded, WYK-LIFT funded with postcode
    // gate, future forms) can land values here without branch-specific
    // logic. `postcode` is normalised to uppercase, no-whitespace form so
    // Session 5.1's JOIN on reference.postcodes has a stable key.
    //
    // Two hidden inputs on the switchable-self-funded form are named with
    // hyphens (`start-when`, `courses-selected`) while the rest use
    // underscores. Reading both forms here makes the router tolerant to
    // that drift; a future switchable/site pass will unify the form on
    // underscores to match the simulator + matrix.json.
    postcode: normalisePostcode(firstString(data["postcode"], data["post_code"])),
    region: null, // populated by Session 5.1 once reference.postcodes is loaded
    reason: firstString(data["reason"]),
    interest: firstString(data["interest"], data["course_interest"]),
    situation: firstString(data["situation"]),
    qualification: firstString(data["qualification"], data["qualification_seeking"]),
    start_when: firstString(data["start_when"], data["start-when"], data["readiness"]),
    budget: firstString(data["budget"]),
    courses_selected: parseStringArray(
      data["courses_selected"] ?? data["courses-selected"],
    ),

    terms_accepted: toBool(data["terms_accepted"]) ?? false,
    marketing_opt_in: toBool(data["marketing_opt_in"]) ?? false,
    is_dq: clientSaysDq,
    dq_reason: dqReason,
    session_id: parseSessionId(data["session_id"]),

    // Experiment attribution fields. Empty hidden inputs (the default for
    // pages with no live experiment) come through as empty strings;
    // firstString returns null for empty/whitespace values, which is the
    // correct shape for the nullable DB columns.
    experiment_id: firstString(data["experiment_id"]),
    experiment_variant: firstString(data["experiment_variant"]),

    raw_payload: rawPayload,
    archived_at: null,
  };

  if (formName === "switchable-funded" || formName.startsWith("switchable-funded-")) {
    const hiddenCourseId = firstString(data["course_id"]);
    const legacyCourseId = formName.startsWith("switchable-funded-")
      ? formName.slice("switchable-funded-".length)
      : null;
    const hiddenProviderIds = parseProviderIds(data["provider_ids"]);
    return {
      ...base,
      course_id: hiddenCourseId ?? legacyCourseId,
      provider_ids:
        hiddenProviderIds.length > 0 ? hiddenProviderIds : ["enterprise-made-simple"],
      funding_category: base.funding_category ?? "gov",
      funding_route: base.funding_route ?? "free_courses_for_jobs",
    };
  }

  if (formName === "switchable-self-funded") {
    const hiddenProviderIds = parseProviderIds(data["provider_ids"]);
    return {
      ...base,
      course_id: firstString(data["course_interest"], data["course_id"]),
      provider_ids: hiddenProviderIds.length > 0 ? hiddenProviderIds : ["courses-direct"],
      funding_category: base.funding_category ?? "self",
      // Owner decision 2026-04-25: leave funding_route as-is (no specific scheme
      // for self-funded yet). Existing form sends 'self', kept for backward
      // compatibility with downstream readers (find-your-course-thank-you GTM).
      funding_route: base.funding_route ?? "self",
    };
  }

  if (formName === "switchable-waitlist") {
    return {
      ...base,
      course_id: firstString(data["course_id"]),
      is_dq: true,
      dq_reason: dqReason ?? "waitlist",
    };
  }

  if (formName === "switchable-waitlist-enrichment") {
    return {
      ...base,
      email: firstString(data["email"], data["ref_token"], body["email"]),
      course_id: firstString(data["course_id"]),
      is_dq: true,
      dq_reason: "waitlist_enrichment",
    };
  }

  return {
    ...base,
    is_dq: true,
    dq_reason: `unknown_form:${formName}`,
  };
}

function applyOwnerTestOverrides(row: CanonicalSubmission): CanonicalSubmission {
  const reason = classifyTestEmail(row.email);
  if (!reason) return row;
  return {
    ...row,
    is_dq: true,
    dq_reason: reason,
    provider_ids: [],
    archived_at: new Date().toISOString(),
  };
}

function classifyTestEmail(
  email: string | null,
): "owner_test_submission" | "dummy_test_email" | null {
  if (!email) return null;
  const normalised = email.trim().toLowerCase();
  if (OWNER_TEST_EMAILS.includes(normalised)) return "owner_test_submission";
  const at = normalised.lastIndexOf("@");
  if (at < 0 || at === normalised.length - 1) return null;
  const domain = normalised.slice(at + 1);
  if (OWNER_TEST_DOMAINS.includes(domain)) return "owner_test_submission";
  if (DUMMY_TEST_DOMAINS.includes(domain)) return "dummy_test_email";
  return null;
}

function parseSessionId(value: JsonValue): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!UUID_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function parseProviderIds(value: JsonValue): string[] {
  return parseStringArray(value);
}

// Generic separator-tolerant string OR JSON-array parser. Splits on both
// `,` and `|` so the switchable-self-funded form's pipe-joined
// `courses-selected` value (`state.selectedCourses.join(' | ')`) round-trips
// as a multi-element array, not a single element with a pipe in it.
// Comma stays supported for provider_ids (used in the switchable-funded
// form hidden input) and any future comma-delimited field.
// Returns [] on null/undefined/non-matching types so callers never need
// a null check before iterating.
function parseStringArray(value: JsonValue): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") {
    return value
      .split(/[,|]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(value)) {
    return value
      .filter((v) => typeof v === "string" && (v as string).trim().length > 0)
      .map((v) => (v as string).trim());
  }
  return [];
}

// Canonicalise a UK postcode to uppercase, no-whitespace form. `PE16 6LS`
// and `pe166ls` both become `PE166LS`. Storing the stable form keeps the
// Session 5.1 JOIN on reference.postcodes simple (single equality on one
// case). The pretty form is recoverable from reference.postcodes.postcode_pretty
// when display is needed.
function normalisePostcode(value: string | null): string | null {
  if (!value) return null;
  const stripped = value.replace(/\s+/g, "").toUpperCase();
  return stripped.length > 0 ? stripped : null;
}

function firstString(...values: JsonValue[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

function toBool(...values: JsonValue[]): boolean | null {
  for (const v of values) {
    if (v === true || v === "true" || v === "yes" || v === "on" || v === "1") return true;
    if (v === false || v === "false" || v === "no" || v === "off" || v === "0") return false;
  }
  return null;
}
