// Shared routing logic. Used by:
//   - routing-confirm  (token-triggered: owner clicks confirm link in email)
//   - netlify-lead-router  (auto-route v1: single-candidate provider with
//                           auto_route_enabled=true)
//
// Both paths perform the same DB writes + sheet append + provider notification
// + audit row. Differences live in the caller:
//   - routing-confirm verifies the HMAC token, then calls routeLead, then
//     renders an HTML confirmation page.
//   - netlify-lead-router checks auto-route eligibility after ingest, calls
//     routeLead in 'auto_route' mode, then sends an FYI email to the owner
//     instead of a confirm-button email.
//
// Audit: every routing event writes an audit.actions row via
// audit.log_system_action. The trigger ('owner_confirm' | 'auto_route') is
// captured in the audit context so the audit log shows how the lead was
// routed, not just that it was.
//
// Failure semantics: routing is recorded BEFORE side effects (sheet append +
// provider email). If side effects fail, dead_letter rows are written and the
// caller is told which side effects landed. Routing in the DB is the source
// of truth — provider gets the lead one way or another (sheet now, or paste
// later from the owner-fallback email).

import type { Sql } from "npm:postgres@3";
import {
  type BrevoAttributes,
  sendBrevoEmail,
  upsertBrevoContact,
} from "./brevo.ts";

// -------- Types --------

export interface ProviderRow {
  provider_id: string;
  company_name: string;
  contact_email: string;
  contact_name: string | null;
  sheet_id: string | null;
  sheet_webhook_url: string | null;
  cc_emails: string[];
  active: boolean;
  archived_at: string | null;
  auto_route_enabled: boolean;
  trust_line: string | null;
  regions: string[] | null;
}

export interface SubmissionRow {
  id: number;
  submitted_at: string;
  course_id: string | null;
  funding_category: string | null;
  funding_route: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  la: string | null;
  region_scheme: string | null;
  age_band: string | null;
  employment_status: string | null;
  prior_level_3_or_higher: boolean | null;
  can_start_on_intake_date: boolean | null;
  outcome_interest: string | null;
  why_this_course: string | null;
  postcode: string | null;
  region: string | null;
  reason: string | null;
  interest: string | null;
  situation: string | null;
  qualification: string | null;
  start_when: string | null;
  budget: string | null;
  courses_selected: string[] | null;
  is_dq: boolean;
  primary_routed_to: string | null;
  archived_at: string | null;
  marketing_opt_in: boolean;
  preferred_intake_id: string | null;
  acceptable_intake_ids: string[] | null;
}

export type RouteTrigger = "owner_confirm" | "auto_route" | "re_application";

// Optional context passed by the caller when trigger='re_application'.
// Carries the parent lead's id and lead_id label so the sheet row + provider
// notification can reference the original cleanly.
export interface ReApplicationContext {
  parentSubmissionId: number;
  parentLeadId: string;
  parentSubmittedAt: string;
}

export type RouteOutcome =
  | { kind: "ok"; submissionId: number; providerId: string; providerCompany: string; sheetAppended: boolean; providerNotified: boolean }
  | { kind: "already_routed_same"; submissionId: number; providerId: string; providerCompany: string }
  | { kind: "already_routed_different"; submissionId: number; providerId: string; existingProvider: string }
  | { kind: "submission_dq"; submissionId: number }
  | { kind: "submission_archived"; submissionId: number; archivedAt: string }
  | { kind: "submission_not_found"; submissionId: number }
  | { kind: "provider_not_found"; providerId: string }
  | { kind: "provider_inactive"; providerId: string }
  | { kind: "db_error"; error: string };

// -------- Public entry point --------

export async function routeLead(
  sql: Sql,
  submissionId: number,
  providerId: string,
  trigger: RouteTrigger,
  reApplicationContext?: ReApplicationContext,
): Promise<RouteOutcome> {
  // Read phase — no writes, no role switch
  let provider: ProviderRow;
  let submission: SubmissionRow;

  try {
    const [providerRow] = await sql<ProviderRow[]>`
      SELECT provider_id, company_name, contact_email, contact_name,
             sheet_id, sheet_webhook_url, cc_emails,
             active, archived_at, auto_route_enabled,
             trust_line, regions
        FROM crm.providers
       WHERE provider_id = ${providerId}
    `;
    if (!providerRow) return { kind: "provider_not_found", providerId };
    if (!providerRow.active || providerRow.archived_at) {
      return { kind: "provider_inactive", providerId };
    }
    provider = providerRow;

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
    if (!submissionRow) return { kind: "submission_not_found", submissionId };
    if (submissionRow.is_dq) return { kind: "submission_dq", submissionId };
    if (submissionRow.archived_at) {
      return { kind: "submission_archived", submissionId, archivedAt: submissionRow.archived_at };
    }
    if (submissionRow.primary_routed_to) {
      if (submissionRow.primary_routed_to === providerId) {
        return { kind: "already_routed_same", submissionId, providerId, providerCompany: provider.company_name };
      }
      return { kind: "already_routed_different", submissionId, providerId, existingProvider: submissionRow.primary_routed_to };
    }
    submission = submissionRow;
  } catch (err) {
    console.error("routeLead read phase failed:", err);
    return { kind: "db_error", error: describeError(err) };
  }

  // Write phase: routing_log INSERT + submissions UPDATE + open-enrolment
  // INSERT atomically. The third call goes through crm.ensure_open_enrolment
  // (SECURITY DEFINER, migration 0042) so functions_writer doesn't need
  // direct INSERT grant on crm.enrolments. Idempotent on (submission_id,
  // provider_id) so a retry can't double-insert.
  let routingLogId: number | null = null;
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      const logRows = await trx<Array<{ id: number }>>`
        INSERT INTO leads.routing_log (
          submission_id, provider_id, route_reason, delivery_method, delivery_status
        ) VALUES (
          ${submission.id}, ${provider.provider_id}, 'primary', 'sheet_webhook', 'sent'
        )
        RETURNING id
      `;
      routingLogId = Number(logRows[0].id);
      await trx`
        UPDATE leads.submissions
           SET primary_routed_to = ${provider.provider_id},
               routed_at         = now(),
               updated_at        = now()
         WHERE id = ${submission.id}
      `;
      await trx`
        SELECT crm.ensure_open_enrolment(
          ${submission.id},
          ${routingLogId},
          ${provider.provider_id}
        )
      `;
    });
  } catch (err) {
    console.error("routeLead write phase failed:", err);
    return { kind: "db_error", error: describeError(err) };
  }

  // Brevo learner upsert (best-effort; failure logs dead_letter, doesn't unwind
  // routing). Fires here so both auto-route and manual-confirm paths trigger
  // the Switchable utility + marketing email automations identically. Skips
  // silently if BREVO_LIST_ID_SWITCHABLE_UTILITY isn't set (i.e. before the
  // owner finishes the Brevo dashboard wiring) — no error, no dead_letter
  // spam, just a no-op until the env vars land.
  await upsertLearnerInBrevo(sql, provider, submission);

  // Side effects (best-effort): sheet append + provider notification.
  //
  // Sheet append payload differs by trigger:
  //   - 'owner_confirm' / 'auto_route': normal Open status. If this lead's
  //     email matches a prior submission elsewhere (different course, or same
  //     course beyond the 90-day re-application window), include a
  //     "Previously applied for X on date" note. Covers Case B + 90-day
  //     stale.
  //   - 're_application': status='Re-applied' (visual flag), notes points
  //     back to parent ('Re-applied — see <parent_lead_id> above'). Same
  //     person re-engaging, marker row at the bottom of the provider's
  //     sheet so they spot the engagement signal where they look.
  const courseTitle = submission.course_id ?? "-";
  let sheetStatus = "Open";
  let sheetNotes: string | null = null;

  if (trigger === "re_application" && reApplicationContext) {
    sheetStatus = "Re-applied";
    sheetNotes = `Re-applied — see ${reApplicationContext.parentLeadId} above`;
  } else {
    const priorNote = await lookupPriorSubmissionNote(sql, submission);
    sheetNotes = priorNote;
  }

  const sheetResult = await appendToProviderSheet(provider, submission, courseTitle, sheetStatus, sheetNotes);

  if (!sheetResult.ok) {
    await persistDeadLetter(sql, "edge_function_sheet_append",
      { provider_id: provider.provider_id, submission_id: submission.id },
      `Sheet webhook append failed: ${sheetResult.error}`);
    await sendOwnerSheetFailureEmail(provider, submission, courseTitle, sheetResult.error ?? "unknown");
    await writeAuditSystem(sql, trigger, submission, provider, { sheet_appended: false, provider_notified: false, error: sheetResult.error });
    return {
      kind: "ok",
      submissionId: submission.id,
      providerId: provider.provider_id,
      providerCompany: provider.company_name,
      sheetAppended: false,
      providerNotified: false,
    };
  }

  const emailResult = await sendProviderNotification(provider, submission, trigger, reApplicationContext);
  if (!emailResult.ok) {
    await persistDeadLetter(sql, "edge_function_provider_email",
      { provider_id: provider.provider_id, submission_id: submission.id },
      `Provider notification email failed: ${emailResult.error}`);
    await writeAuditSystem(sql, trigger, submission, provider, { sheet_appended: true, provider_notified: false, error: emailResult.error });
    return {
      kind: "ok",
      submissionId: submission.id,
      providerId: provider.provider_id,
      providerCompany: provider.company_name,
      sheetAppended: true,
      providerNotified: false,
    };
  }

  await writeAuditSystem(sql, trigger, submission, provider, { sheet_appended: true, provider_notified: true });

  return {
    kind: "ok",
    submissionId: submission.id,
    providerId: provider.provider_id,
    providerCompany: provider.company_name,
    sheetAppended: true,
    providerNotified: true,
  };
}

// -------- Brevo learner upsert + course context fetch --------

// Switchable site publishes matrix.json on every deploy. Same file the
// /tools/form-matrix simulator and the funded course pages already use.
// We fetch + cache it here so route-lead can resolve a course slug to its
// display title and next-intake date for Brevo email attributes.
//
// Fail-safe: any error returns nulls. The Brevo upsert falls back to using
// the slug as COURSE_NAME and omits COURSE_START_DATE entirely. Email still
// ships, lead still nurtures, copy degrades slightly. Same best-effort
// pattern as sheet append + provider notification.
//
// Cache: 5 minutes in-module. Edge Function instances are recycled between
// cold starts so this is naturally bounded; fresh deploys see fresh data
// within 5 minutes of the site rebuild.

const MATRIX_URL = "https://switchable.org.uk/data/matrix.json";
const MATRIX_CACHE_MS = 5 * 60 * 1000;
const MATRIX_TIMEOUT_MS = 3000;

interface MatrixIntake {
  id?: string;
  date?: string;
  dateFormatted?: string;
}

interface MatrixRoute {
  // Page slug — matches submission.course_id. Index key.
  slug?: string;
  // Course-only slug (YAML id, e.g. "smm-for-ecommerce"). Added 2026-04-29.
  courseId?: string;
  courseTitle?: string;
  regionName?: string;
  cfInterest?: string | null;
  ffInterest?: string | null;
  nextIntake?: string;
  nextIntakeFormatted?: string;
  intakes?: MatrixIntake[];
}

interface MatrixCache {
  loadedAt: number;
  routes: Map<string, MatrixRoute>;
}

interface MatrixContext {
  courseId: string | null;       // course-only slug
  courseTitle: string | null;
  regionName: string | null;
  intakeId: string | null;
  intakeDate: string | null;     // ISO YYYY-MM-DD — Brevo Date attribute requires this format
  cfInterest: string | null;
  ffInterest: string | null;
}

const EMPTY_MATRIX_CONTEXT: MatrixContext = {
  courseId: null,
  courseTitle: null,
  regionName: null,
  intakeId: null,
  intakeDate: null,
  cfInterest: null,
  ffInterest: null,
};

let matrixCache: MatrixCache | null = null;

// Resolve a submission's page slug against matrix.json. Returns the
// course-only slug, course title, region name, the matched intake, and the
// course's interest tags so callers can compose Brevo attributes (or any
// other downstream context) without re-deriving from page slugs.
async function getMatrixContext(
  pageSlug: string | null,
  preferredIntakeId: string | null,
): Promise<MatrixContext> {
  if (!pageSlug) return EMPTY_MATRIX_CONTEXT;

  const now = Date.now();
  if (matrixCache && now - matrixCache.loadedAt < MATRIX_CACHE_MS) {
    return readRoute(matrixCache.routes, pageSlug, preferredIntakeId);
  }

  // Single AbortController covers both the fetch handshake and the body read.
  // Brevo got bitten in Session 3.3 by a slow body read after the timeout
  // had cleared; same pattern would hang routing-confirm here. Keep the
  // controller live until the JSON is fully read, then clear.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MATRIX_TIMEOUT_MS);
  let res: Response;
  let payload: unknown;
  try {
    res = await fetch(MATRIX_URL, { signal: controller.signal });
    if (!res.ok) {
      console.error(`matrix.json fetch ${res.status}`);
      return EMPTY_MATRIX_CONTEXT;
    }
    payload = await res.json();
  } catch (err) {
    console.error("matrix.json fetch/parse failed:", String(err));
    return EMPTY_MATRIX_CONTEXT;
  } finally {
    clearTimeout(timeoutId);
  }

  const routes = new Map<string, MatrixRoute>();
  const inner = (payload && typeof payload === "object")
    ? (payload as { routes?: unknown }).routes
    : payload;
  if (Array.isArray(inner)) {
    for (const entry of inner as MatrixRoute[]) {
      if (entry && typeof entry.slug === "string") {
        routes.set(entry.slug, entry);
      }
    }
  }

  matrixCache = { loadedAt: now, routes };
  return readRoute(routes, pageSlug, preferredIntakeId);
}

function readRoute(
  routes: Map<string, MatrixRoute>,
  pageSlug: string,
  preferredIntakeId: string | null,
): MatrixContext {
  const route = routes.get(pageSlug);
  if (!route) {
    console.error(`matrix.json: route not found for slug '${pageSlug}'`);
    return EMPTY_MATRIX_CONTEXT;
  }

  // Intake resolution: prefer the learner's chosen intake if present in the
  // route's intakes[]. Otherwise fall back to the legacy single-cohort
  // nextIntake field. Rolling-intake routes (no intakes[] entries) end up
  // with null intake fields, which is correct.
  //
  // Date format: Brevo's Date attribute type silently nulls anything that
  // isn't ISO 8601 YYYY-MM-DD. Use intake.date / route.nextIntake (ISO),
  // never dateFormatted / nextIntakeFormatted (human-readable).
  let intakeId: string | null = null;
  let intakeDate: string | null = null;
  if (preferredIntakeId && Array.isArray(route.intakes)) {
    const match = route.intakes.find((i) => i?.id === preferredIntakeId);
    if (match) {
      intakeId = match.id ?? null;
      intakeDate = match.date ?? null;
    }
  }
  if (!intakeId && Array.isArray(route.intakes) && route.intakes.length > 0) {
    intakeId = route.intakes[0].id ?? null;
    intakeDate = route.intakes[0].date ?? null;
  }
  if (!intakeDate) {
    intakeDate = route.nextIntake ?? null;
  }

  return {
    courseId: route.courseId ?? null,
    courseTitle: route.courseTitle ?? null,
    regionName: route.regionName ?? null,
    intakeId,
    intakeDate,
    cfInterest: route.cfInterest ?? null,
    ffInterest: route.ffInterest ?? null,
  };
}

// Composes the learner's Brevo contact from the submission + provider rows
// and upserts it into the Switchable utility list (contract basis, every
// matched lead) plus the marketing list if marketing_opt_in=true (consent
// basis). The marketing list is a single consolidated list — earlier
// designs split nurture vs monthly; collapsed 2026-04-29 because cadence
// is a Brevo Automation concern, not a list-membership concern.
// Brevo Automations watch list membership + attribute updates to trigger
// the utility and marketing sequences described in switchable/email/.
//
// Best-effort: failure logs a leads.dead_letter row and returns. Routing is
// already committed by the time we get here; Brevo is a downstream side-
// effect on the same footing as sheet append + provider notification.
export async function upsertLearnerInBrevo(
  sql: Sql,
  provider: ProviderRow,
  submission: SubmissionRow,
): Promise<void> {
  if (!submission.email) return;

  const utilityListId = parseEnvInt("BREVO_LIST_ID_SWITCHABLE_UTILITY");
  const marketingListId = parseEnvInt("BREVO_LIST_ID_SWITCHABLE_MARKETING");

  if (utilityListId == null) {
    // Email launch hasn't been wired yet — silently skip rather than spam
    // dead_letter. Owner sets the list IDs once Brevo dashboard is configured.
    return;
  }

  const matrix = await getMatrixContext(submission.course_id, submission.preferred_intake_id);

  // SW_SECTOR maps to the course's interest tag in the funding-appropriate
  // taxonomy. Funded leads (gov funding_category) read ffInterest because
  // that's what /find-funded-courses categorises by; self-funded and
  // loan-funded leads read cfInterest because that's the course-finder
  // taxonomy. Falls back to the other side if the primary is missing.
  const sector = submission.funding_category === "gov"
    ? (matrix.ffInterest ?? matrix.cfInterest)
    : (matrix.cfInterest ?? matrix.ffInterest);

  // Attribute namespacing: FIRSTNAME / LASTNAME stay as unprefixed Brevo
  // defaults (built-in fields). Everything Switchable-specific carries an
  // SW_ prefix so it doesn't collide with future SwitchLeads SL_-prefixed
  // attributes on the same Brevo contact (one email = one Brevo contact
  // across both brands). Decision 2026-04-29.
  const attributes: BrevoAttributes = {
    FIRSTNAME: submission.first_name ?? "",
    LASTNAME: submission.last_name ?? "",
    SW_COURSE_NAME: matrix.courseTitle ?? submission.course_id ?? "",
    SW_COURSE_SLUG: matrix.courseId ?? "",
    SW_COURSE_INTAKE_ID: matrix.intakeId ?? "",
    SW_COURSE_INTAKE_DATE: matrix.intakeDate ?? "",
    SW_REGION_NAME: matrix.regionName ?? "",
    SW_SECTOR: sector ?? "",
    SW_PROVIDER_NAME: provider.company_name,
    SW_PROVIDER_TRUST_LINE: provider.trust_line ?? "",
    SW_FUNDING_CATEGORY: submission.funding_category ?? "",
    SW_FUNDING_ROUTE: submission.funding_route ?? "",
    // SW_AGE_BAND deferred to v2 — form age-question is being redesigned
    // (under 19 / 19-23 / 24-34 / 35+) for nurture branching. Pushing the
    // current age_band shape would mean migrating Brevo contact records
    // when the new shape lands. Cleaner to not push it at all at v1.
    SW_EMPLOYMENT_STATUS: submission.employment_status ?? "",
    SW_OUTCOME_INTEREST: submission.outcome_interest ?? "",
    SW_CONSENT_MARKETING: submission.marketing_opt_in,
    // SW_MATCH_STATUS lets Brevo Automations trigger off attribute updates
    // without needing a separate event API. See _shared/brevo.ts comment.
    SW_MATCH_STATUS: "matched",
  };

  // One upsert call adds the contact to both lists atomically. Previously
  // this was a two-call sequence (upsert + addContactToList) which raced
  // against Brevo's backend and surfaced the misleading "Contact already in
  // list and/or does not exist" 400. Single call eliminates the race.
  const listIds = [utilityListId];
  if (submission.marketing_opt_in && marketingListId != null) {
    listIds.push(marketingListId);
  }

  const upsertResult = await upsertBrevoContact({
    email: submission.email,
    attributes,
    listIds,
  });

  if (!upsertResult.ok) {
    await persistDeadLetter(sql, "edge_function_brevo_upsert",
      { provider_id: provider.provider_id, submission_id: submission.id },
      `Brevo learner upsert failed: ${upsertResult.error ?? "unknown"}`);
  }
}

function parseEnvInt(name: string): number | null {
  const raw = Deno.env.get(name);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

// -------- Prior-submission lookup (for "previously applied" sheet note) --------

async function lookupPriorSubmissionNote(
  sql: Sql,
  submission: SubmissionRow,
): Promise<string | null> {
  if (!submission.email) return null;
  try {
    const [prior] = await sql<Array<{ id: number; submitted_at: string; course_id: string | null }>>`
      SELECT id, submitted_at, course_id
        FROM leads.submissions
       WHERE LOWER(email) = LOWER(${submission.email})
         AND id != ${submission.id}
         AND archived_at IS NULL
       ORDER BY submitted_at DESC
       LIMIT 1
    `;
    if (!prior) return null;
    const priorLeadId = formatLeadId(Number(prior.id), prior.submitted_at);
    const priorDate = formatUkDate(prior.submitted_at);
    const courseFragment = prior.course_id ? ` for ${prior.course_id}` : "";
    return `Previously applied${courseFragment} on ${priorDate} (${priorLeadId})`;
  } catch (err) {
    console.error("prior-submission lookup failed:", err);
    return null;
  }
}

function formatUkDate(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// -------- Sheet append --------

async function appendToProviderSheet(
  provider: ProviderRow,
  submission: SubmissionRow,
  courseTitle: string,
  sheetStatus: string,
  sheetNotes: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!provider.sheet_webhook_url) {
    return { ok: false, error: "provider has no sheet_webhook_url configured" };
  }
  const token = Deno.env.get("SHEETS_APPEND_TOKEN");
  if (!token) {
    return { ok: false, error: "SHEETS_APPEND_TOKEN not set" };
  }

  const lc = (v: string | null | undefined) => (v ?? "").toLowerCase();
  const coursesSelectedCsv = (submission.courses_selected ?? []).join(", ");
  const row = {
    token,
    lead_id: lc(formatLeadId(submission.id, submission.submitted_at)),
    submission_id: submission.id,
    submitted_at: lc(formatUkTimestamp(submission.submitted_at)),
    course: lc(courseTitle),
    course_id: lc(submission.course_id),
    funding_category: lc(submission.funding_category),
    funding_route: lc(submission.funding_route),
    provider: provider.provider_id,
    status: sheetStatus,
    name: lc([submission.first_name, submission.last_name].filter(Boolean).join(" ")),
    first_name: lc(submission.first_name),
    last_name: lc(submission.last_name),
    email: lc(submission.email),
    phone: lc(submission.phone),
    la: lc(submission.la),
    region_scheme: lc(submission.region_scheme),
    age_band: lc(submission.age_band),
    employment: lc(submission.employment_status),
    prior_l3: lc(boolToYesNo(submission.prior_level_3_or_higher)),
    start_date_checked: lc(boolToYesNo(submission.can_start_on_intake_date)),
    outcome_interest: lc(submission.outcome_interest),
    why_this_course: lc(submission.why_this_course),
    postcode: lc(submission.postcode),
    region: lc(submission.region),
    reason: lc(submission.reason),
    interest: lc(submission.interest),
    situation: lc(submission.situation),
    qualification: lc(submission.qualification),
    start_when: lc(submission.start_when),
    budget: lc(submission.budget),
    courses_selected: lc(coursesSelectedCsv),

    // Cohort intake fields (lead payload schema 1.2). Apps Script v2 picks
    // these up if the provider's sheet has matching headers ("Preferred
    // intake", "Acceptable intakes"). Empty / NULL passes through as
    // empty string so single-cohort and rolling-intake leads don't write
    // garbage rows.
    preferred_intake_id: lc(submission.preferred_intake_id),
    acceptable_intake_ids: lc((submission.acceptable_intake_ids ?? []).join(", ")),

    // Provider-sheet notes column. Apps Script v2 FIELD_MAP recognises
    // "notes" / "note" / "comment" / "comments" header names. Populated
    // for re-applications (points to original) and for prior-submission
    // matches (Case B / 90-day stale).
    notes: sheetNotes ?? "",
  };

  let res: Response;
  try {
    res = await fetch(provider.sheet_webhook_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(row),
    });
  } catch (err) {
    return { ok: false, error: `fetch failed: ${String(err)}` };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "<body unreadable>");
    return { ok: false, error: `apps script ${res.status}: ${text.slice(0, 300)}` };
  }

  try {
    const body = await res.json() as { ok?: boolean; error?: string };
    if (body.ok === true) return { ok: true };
    return { ok: false, error: body.error ?? "apps script returned ok=false" };
  } catch {
    return { ok: true };
  }
}

// -------- Emails --------

async function sendProviderNotification(
  provider: ProviderRow,
  submission: SubmissionRow,
  trigger: RouteTrigger,
  reApplicationContext?: ReApplicationContext,
): Promise<{ ok: boolean; error?: string }> {
  const leadId = formatLeadId(submission.id, submission.submitted_at);
  const sheetLink = provider.sheet_id
    ? `https://docs.google.com/spreadsheets/d/${provider.sheet_id}/edit`
    : null;

  const ownerEmail = Deno.env.get("OWNER_NOTIFICATION_EMAIL") ?? Deno.env.get("BREVO_SENDER_EMAIL");
  const ccList = buildCcList(ownerEmail, provider.cc_emails);

  // Re-application: PII-free, references the parent lead by its label, points
  // the provider at the marker row at the bottom of the sheet (status='Re-applied').
  if (trigger === "re_application" && reApplicationContext) {
    const html = `
      <p>Hi ${provider.contact_name ?? "there"},</p>
      <p>A previous enquiry (${reApplicationContext.parentLeadId}) has just resubmitted the form.</p>
      ${sheetLink ? `<p><a href="${sheetLink}">Open your sheet</a></p>` : ""}
      <p>You'll see a new row at the bottom of your sheet with status <strong>Re-applied</strong>, referencing the original. This is a positive engagement signal — they're still keen. Worth a follow-up if you haven't already, or update the original row's status if you've spoken.</p>
      <p>Thanks,<br>SwitchLeads</p>
    `.trim();
    return await sendBrevoEmail({
      to: [{ email: provider.contact_email, name: provider.contact_name ?? provider.company_name }],
      cc: ccList.length > 0 ? ccList : undefined,
      subject: `Re-applied: ${reApplicationContext.parentLeadId}`,
      htmlContent: html,
      tags: ["route-lead", "re-application", "provider-notification"],
    });
  }

  // Standard new-enquiry email (auto-route + owner-confirm paths)
  const html = `
    <p>Hi ${provider.contact_name ?? "there"},</p>
    <p>You have a new enquiry (${leadId}) in your SwitchLeads sheet.</p>
    ${sheetLink ? `<p><a href="${sheetLink}">Open your sheet</a></p>` : ""}
    <p>The lead has been added with status <strong>open</strong>. Please update the status and notes as you work through the follow-up.</p>
    <p>Thanks,<br>SwitchLeads</p>
  `.trim();

  return await sendBrevoEmail({
    to: [{ email: provider.contact_email, name: provider.contact_name ?? provider.company_name }],
    cc: ccList.length > 0 ? ccList : undefined,
    subject: `New enquiry - ${leadId}`,
    htmlContent: html,
    tags: ["route-lead", "provider-notification"],
  });
}

async function sendOwnerSheetFailureEmail(
  provider: ProviderRow,
  submission: SubmissionRow,
  courseTitle: string,
  error: string,
): Promise<void> {
  const leadId = formatLeadId(submission.id, submission.submitted_at);
  const name = [submission.first_name, submission.last_name].filter(Boolean).join(" ") || "(no name)";

  const fields: Array<[string, string | null]> = [
    ["Lead ID", leadId],
    ["Submitted at", formatUkTimestamp(submission.submitted_at)],
    ["Course", courseTitle],
    ["Name", name === "(no name)" ? null : name],
    ["Email", submission.email],
    ["Phone", submission.phone],
    ["Local authority", submission.la],
    ["Region scheme", submission.region_scheme],
    ["Age band", submission.age_band],
    ["Employment", submission.employment_status],
    ["Prior L3", boolToYesNo(submission.prior_level_3_or_higher) || null],
    ["Can start on intake", boolToYesNo(submission.can_start_on_intake_date) || null],
    ["Outcome interest", submission.outcome_interest],
    ["Why this course", submission.why_this_course],
    ["Postcode", submission.postcode],
    ["Region", submission.region],
    ["Reason", submission.reason],
    ["Interest", submission.interest],
    ["Situation", submission.situation],
    ["Qualification seeking", submission.qualification],
    ["Start when", submission.start_when],
    ["Budget", submission.budget],
    ["Courses selected", (submission.courses_selected ?? []).join(", ") || null],
    ["Provider", provider.company_name],
    ["Status", "open"],
  ];
  const fieldRows = fields
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#666;vertical-align:top;">${escapeHtml(k)}</td><td style="padding:2px 0;">${escapeHtml(v as string)}</td></tr>`)
    .join("");

  const html = `
    <p>Routing recorded for ${escapeHtml(provider.company_name)}, but the Apps Script append failed.</p>
    <p><strong>Error:</strong> ${escapeHtml(error)}</p>
    <p><strong>Lead details - paste into ${escapeHtml(provider.company_name)}'s sheet manually:</strong></p>
    <table style="border-collapse:collapse;font-size:14px;">${fieldRows}</table>
    <p>Provider has NOT been emailed - notify ${escapeHtml(provider.contact_email)} manually this once.</p>
    <p>A leads.dead_letter row has been written (source=edge_function_sheet_append) so Sasha's weekly scan will flag if this pattern repeats.</p>
  `.trim();

  const ownerEmail = Deno.env.get("OWNER_NOTIFICATION_EMAIL") ?? Deno.env.get("BREVO_SENDER_EMAIL");
  if (!ownerEmail) {
    console.error("No owner email address configured for sheet failure notification");
    return;
  }

  await sendBrevoEmail({
    to: [{ email: ownerEmail, name: "Charlotte" }],
    subject: `Sheet append failed - ${leadId} - ${provider.company_name}`,
    htmlContent: html,
    tags: ["route-lead", "owner-fallback"],
  });
}

// -------- Helpers --------

function buildCcList(
  ownerEmail: string | undefined,
  providerCcEmails: string[] | null,
): Array<{ email: string; name?: string }> {
  const seen = new Set<string>();
  const result: Array<{ email: string; name?: string }> = [];
  const add = (email: string | null | undefined, name?: string) => {
    if (!email) return;
    const key = email.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(name ? { email, name } : { email });
  };
  add(ownerEmail, "Charlotte");
  for (const cc of providerCcEmails ?? []) add(cc);
  return result;
}

async function persistDeadLetter(
  sql: Sql,
  source: string,
  payload: Record<string, unknown>,
  errorContext: string,
): Promise<void> {
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        INSERT INTO leads.dead_letter (source, raw_payload, error_context)
        VALUES (${source}, ${trx.json(payload)}, ${errorContext})
      `;
    });
  } catch (err) {
    console.error("failed to write dead_letter row:", err);
  }
}

async function writeAuditSystem(
  sql: Sql,
  trigger: RouteTrigger,
  submission: SubmissionRow,
  provider: ProviderRow,
  outcome: { sheet_appended: boolean; provider_notified: boolean; error?: string },
): Promise<void> {
  try {
    const actor = trigger === "auto_route"
      ? "system:auto_route:lead_router"
      : trigger === "re_application"
        ? "system:re_application:lead_router"
        : "system:owner_confirm:routing_confirm";
    const action = trigger === "auto_route"
      ? "auto_route_lead"
      : trigger === "re_application"
        ? "auto_route_lead_re_application"
        : "owner_confirm_route_lead";
    await sql`
      SELECT audit.log_system_action(
        ${actor},
        ${action},
        ${"leads.submissions"},
        ${String(submission.id)},
        ${null},
        ${sql.json({ primary_routed_to: provider.provider_id, routed_at: new Date().toISOString() })},
        ${sql.json({ trigger, provider_id: provider.provider_id, ...outcome })}
      )
    `;
  } catch (err) {
    console.error("audit log write failed:", err);
  }
}

export function formatLeadId(id: number, submittedAt: string): string {
  const d = new Date(submittedAt);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const nnnn = String(id).padStart(4, "0");
  return `SL-${yy}-${mm}-${nnnn}`;
}

export function formatUkTimestamp(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

function boolToYesNo(v: boolean | null): string {
  if (v === true) return "Yes";
  if (v === false) return "No";
  return "";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function describeError(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) {
    const pgErr = err as Error & { code?: string; detail?: string };
    const parts: string[] = [];
    if (pgErr.code) parts.push(`code=${pgErr.code}`);
    if (err.message) parts.push(err.message);
    if (pgErr.detail) parts.push(pgErr.detail);
    return parts.join(" | ");
  }
  return String(err);
}
