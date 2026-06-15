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
import { getOwnerEmail, adminLeadUrl } from "./owner-email.ts";
import {
  type BrevoAttributes,
  sendBrevoEmail,
  sendTransactional,
  upsertBrevoContact,
} from "./brevo.ts";

// -------- Types --------

export interface RegionalContactEntry {
  first_name: string;
  name: string;
  phone: string;
}

export interface RegionalContacts {
  by_la?: Record<string, RegionalContactEntry>;
}

export interface ProviderRow {
  provider_id: string;
  company_name: string;
  contact_email: string;
  contact_name: string | null;
  sheet_id: string | null;
  sheet_webhook_url: string | null;
  crm_webhook_url: string | null;
  cc_emails: string[];
  active: boolean;
  archived_at: string | null;
  auto_route_enabled: boolean;
  trust_line: string | null;
  regions: string[] | null;
  portal_enabled: boolean;
  regional_contacts: RegionalContacts | null;
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
  earnings_band: string | null;
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
  dq_reason: string | null;
  primary_routed_to: string | null;
  archived_at: string | null;
  marketing_opt_in: boolean;
  // Private-pay fallback (migration 0207). 'private' = learner failed funding
  // and chose to pay; routes despite is_dq. NULL on normal funded leads.
  pay_route: string | null;
  preferred_intake_id: string | null;
  acceptable_intake_ids: string[] | null;
  referral_code: string | null;
  // Migration 0099 enrichment fields. NULL on any submission that didn't
  // come through (or wasn't enriched by) the switchable-waitlist-enrichment
  // form. Pushed to Brevo as SW_PHONE / SW_START_TIMING / etc.
  start_timing: string | null;
  interest_breadth: string | null;
  investment_willingness: string | null;
  current_qualification: string | null;
  source_form: string | null;
  enriched_at: string | null;
  // Migration 0087: stamped by fastrack-receive when fastrack form lands.
  // NULL until fastracked. Pushed to Brevo as SW_FASTRACK_COMPLETED boolean.
  fastracked_at: string | null;
  // Migration 0087: client-generated UUIDv4 set by funded form pre-submit JS.
  // Used to compose SW_FASTRACK_URL for nurture-email deep-links into the
  // fastrack form, plus parent-lookup for cohort_decline / l3_mismatch
  // enrichment via parent_ref. NULL on legacy pre-0087 rows.
  client_nonce: string | null;
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
             sheet_id, sheet_webhook_url, crm_webhook_url, cc_emails,
             active, archived_at, auto_route_enabled,
             trust_line, regions, portal_enabled, regional_contacts
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
             outcome_interest, why_this_course, earnings_band,
             postcode, region, reason, interest, situation,
             qualification, start_when, budget, courses_selected,
             is_dq, dq_reason, primary_routed_to, archived_at,
             marketing_opt_in, pay_route,
             preferred_intake_id, acceptable_intake_ids,
             referral_code, client_nonce,
             start_timing, interest_breadth, investment_willingness,
             current_qualification, source_form, enriched_at,
             fastracked_at
        FROM leads.submissions
       WHERE id = ${submissionId}
    `;
    if (!submissionRow) return { kind: "submission_not_found", submissionId };
    // Private-pay leads carry is_dq=true (failed funding) but ARE routable: the
    // learner chose to pay. Only block routing for genuine (non-paying) DQ rows.
    if (submissionRow.is_dq && submissionRow.pay_route !== "private") {
      return { kind: "submission_dq", submissionId };
    }
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
  // routing). Fires here so both auto-route and manual-confirm paths upsert
  // the contact + sync attributes + push channel-subscription state identically.
  // Utility emails no longer rely on this — they moved to the Brevo
  // Transactional API in the 2026-05-07 cutover. Marketing automations still
  // do (Email campaigns channel + entry filters). The Switchable Utility list
  // membership is legacy; the upsert keeps adding to it during the 90-day
  // retention window so the list can be deleted on 2026-08-06.
  await upsertLearnerInBrevo(sql, provider, submission);

  // U1 transactional send (Phase 2a of email rearchitecture). Same posture as
  // upsertLearnerInBrevo: best-effort, both routing paths, fails silently if
  // template env vars haven't been set yet. While BREVO_SHADOW_MODE=true the
  // existing list-add automation also fires (via upsertLearnerInBrevo above),
  // so the learner gets two U1s during parity verification.
  await sendU1Transactional(sql, provider, submission, trigger);

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

  // Private-pay learners route like funded leads but pay the course fee
  // themselves (they did not qualify for funding and chose to pay). The
  // provider must bill the learner directly, not enrol them as a funded place.
  // Status stays "Open" (reconcile parses that column), so the flag rides in
  // the notes column instead, prepended ahead of any prior-submission note.
  if (submission.pay_route === "private") {
    const privatePayNote = "PRIVATE PAY — learner self-funds, bill them the course fee directly (not a funded place)";
    sheetNotes = sheetNotes ? `${privatePayNote}. ${sheetNotes}` : privatePayNote;
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

  // Optional: push the same lead to the provider's CRM webhook (HubSpot
  // form submission URL, Zapier catch hook, etc). Failure is non-fatal —
  // sheet still got the row, lead can still be worked. Failure persists
  // to dead_letter so the owner can retry or fix the URL.
  if (provider.crm_webhook_url) {
    const crmResult = await pushToProviderCrm(provider, submission, courseTitle, sheetStatus);
    if (!crmResult.ok) {
      await persistDeadLetter(sql, "edge_function_crm_push",
        { provider_id: provider.provider_id, submission_id: submission.id, crm_webhook_url: provider.crm_webhook_url },
        `CRM webhook push failed: ${crmResult.error}`);
    }
  }

  const emailResult = await sendProviderNotification(sql, provider, submission, trigger, reApplicationContext);
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
  schedule?: string;
  // Course-state flag (Wren push 2026-05-25). True/absent means the course is
  // accepting new learner applications, false means it's closed. Drives
  // SW_COURSE_OPEN on the Brevo contact so N1-N3 has a course-state exit
  // condition. Surfaced into matrix.json by the switchable/site build script
  // from the course YAML's `accepting_applications` field (default true).
  acceptingApplications?: boolean;
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
  courseSchedule: string | null;
  // True when the course is accepting new applications. Defaults to true so
  // any course YAML without the explicit field stays open. Pushed as
  // SW_COURSE_OPEN to Brevo on every upsert.
  courseAcceptingApplications: boolean;
}

const EMPTY_MATRIX_CONTEXT: MatrixContext = {
  courseId: null,
  courseTitle: null,
  regionName: null,
  intakeId: null,
  intakeDate: null,
  cfInterest: null,
  ffInterest: null,
  courseSchedule: null,
  // Default open. A submission whose page slug doesn't resolve in matrix.json
  // shouldn't be marked as a closed course — it's an unknown route, not a
  // closed one. Marking SW_COURSE_OPEN=true is the safe default.
  courseAcceptingApplications: true,
};

let matrixCache: MatrixCache | null = null;

// Resolve a submission's page slug against matrix.json. Returns the
// course-only slug, course title, region name, the matched intake, and the
// course's interest tags so callers can compose Brevo attributes (or any
// other downstream context) without re-deriving from page slugs.
export async function getMatrixContext(
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
    courseSchedule: route.schedule ?? null,
    // Explicit false closes the course. Anything else (undefined / true /
    // omitted) keeps it open. Backwards-compatible with matrix.json builds
    // that don't yet emit the field.
    courseAcceptingApplications: route.acceptingApplications !== false,
  };
}

// DB enum uses "cannot_reach"; Brevo's SW_ENROL_STATUS Category attribute uses
// "cannot_contact". Confirmed 2026-04-30 by owner direct from Brevo dashboard.
// Mapping is one-directional (DB → Brevo) and applied only at the upsert
// boundary so the rest of the codebase stays on the canonical DB taxonomy.
// Other values (open / enrolled / presumed_enrolled / lost) match exactly and
// pass through. Empty string also passes through (no enrolment row yet).
const ENROL_STATUS_DB_TO_BREVO: Record<string, string> = {
  cannot_reach: "cannot_contact",
};

function mapEnrolStatusForBrevo(dbStatus: string): string {
  return ENROL_STATUS_DB_TO_BREVO[dbStatus] ?? dbStatus;
}

// Per-email aggregated state for the Brevo upsert. Solves the duplicate-
// submission overwrite problem: one email = one Brevo contact, but the same
// email can have multiple submissions (re-applications, DQ duplicates). The
// upsert path used to read state from THE submission being processed, so
// whichever submission upserted last won — usually the most recent which was
// often a DQ duplicate. Result: Brevo cards drifted away from the canonical
// state per email.
//
// This aggregate pulls the canonical inputs across all submissions for an
// email, so any submission's upsert lands the same SW_FASTRACK_COMPLETED /
// SW_FASTRACK_URL / SW_REFERRAL_URL / SW_REFERRAL_CODE values. The
// admin-brevo-resync backfill uses identical logic (latest-opt-in for URLs,
// earliest-with-referral_code for referral, bool_or across all for fastrack
// flag), so the two paths stay in agreement and the backfill panel goes
// from "always shows drift" to "actually finds drift only when broken".
//
// Course/region/provider/enrol attributes deliberately STAY per-submission —
// those reflect the immediate routing event, and the current submission IS
// the right source for them.
//
// SW_FASTRACK_COMPLETED was historically computed as bool_or(fastracked_at)
// across every submission for the email — meaning anyone who ever fastracked
// any past course stayed "completed" forever. Wrong for re-applicants on a
// new course (Wren push 2026-05-25). The first fix read the single canonical
// submission's flag, which then broke the opposite way: a same-course
// re-application child (fastracked_at NULL) became canonical and wiped a real
// completion. It's now a bool_or scoped to the canonical course_id — correct
// in both directions (per-course, but resilient to re-application children).
interface EmailAggregateState {
  clientNonce: string | null;
  courseId: string | null;
  marketingOptIn: boolean | null;
  referralCode: string | null;
  canonicalFastracked: boolean;
}

async function loadEmailAggregateState(
  sql: Sql,
  email: string,
): Promise<EmailAggregateState> {
  // Single combined SELECT for opt-in + latest carries fastracked_at alongside
  // the canonical fields. Saves the extra round-trip the old bool_or query
  // needed.
  const [optIn, anyLatest, earliestRef] = await Promise.all([
    sql<Array<{ client_nonce: string | null; course_id: string | null; marketing_opt_in: boolean | null; fastracked: boolean }>>`
      SELECT client_nonce, course_id, marketing_opt_in,
             (fastracked_at IS NOT NULL) AS fastracked
        FROM leads.submissions
       WHERE lower(email) = lower(${email})
         AND archived_at IS NULL
         AND marketing_opt_in = true
       ORDER BY submitted_at DESC, id DESC
       LIMIT 1
    `,
    sql<Array<{ client_nonce: string | null; course_id: string | null; marketing_opt_in: boolean | null; fastracked: boolean }>>`
      SELECT client_nonce, course_id, marketing_opt_in,
             (fastracked_at IS NOT NULL) AS fastracked
        FROM leads.submissions
       WHERE lower(email) = lower(${email})
         AND archived_at IS NULL
       ORDER BY submitted_at DESC, id DESC
       LIMIT 1
    `,
    sql<Array<{ referral_code: string | null }>>`
      SELECT referral_code
        FROM leads.submissions
       WHERE lower(email) = lower(${email})
         AND archived_at IS NULL
         AND referral_code IS NOT NULL
       ORDER BY submitted_at ASC, id ASC
       LIMIT 1
    `,
  ]);

  const canonical = optIn[0] ?? anyLatest[0];
  const canonicalCourseId = canonical?.course_id ?? null;

  // SW_FASTRACK_COMPLETED is a per-canonical-course bool_or, NOT the single
  // canonical row's flag. A same-course re-application creates a child row with
  // fastracked_at = NULL; if that child is the latest submission it becomes the
  // canonical row, and reading only its flag wrongly reports "not fastracked",
  // overwriting a real completion on an earlier same-course row (the Amanda
  // Robinson / Kirsty Crowther bug, S19 watch item). Scoping bool_or to the
  // canonical course keeps Wren's 2026-05-25 cross-course fix intact — a
  // fastrack on a DIFFERENT course still does not count for this course — while
  // fixing the within-course re-application case the single-row read broke.
  const [courseFastrack] = await sql<Array<{ fastracked: boolean }>>`
    SELECT bool_or(fastracked_at IS NOT NULL) AS fastracked
      FROM leads.submissions
     WHERE lower(email) = lower(${email})
       AND archived_at IS NULL
       AND course_id IS NOT DISTINCT FROM ${canonicalCourseId}
  `;

  return {
    clientNonce: canonical?.client_nonce ?? null,
    courseId: canonicalCourseId,
    marketingOptIn: canonical?.marketing_opt_in ?? null,
    referralCode: earliestRef[0]?.referral_code ?? null,
    canonicalFastracked: courseFastrack?.fastracked ?? false,
  };
}

// ─── SW_PENDING_RESTART (Wren push 2026-05-25) ──────────────────────────────
// Flip detection for the canonical-course-changed signal. Reads the per-email
// "last canonical course we pushed" from crm.brevo_contact_state (migration
// 0168). Returns flipped=true when the new canonical differs from the
// previously stored value AND a previous value existed (first-time leads
// have no row → flipped=false, per Wren spec "first-time leads leave it
// untouched"). Both same-course re-submits and DQ duplicates that don't move
// the canonical return flipped=false.
//
// Caller pattern:
//   1. Compute agg = loadEmailAggregateState(...) — already needed for build.
//   2. const { flipped } = await detectCanonicalCourseFlip(sql, email, agg.courseId).
//   3. If flipped: set SW_PENDING_RESTART=true on the Brevo attribute object.
//   4. Call upsertBrevoContact.
//   5. On success: await recordCanonicalCourse(sql, email, agg.courseId).
// Steps 2 + 5 wrap the upsert; failure at step 4 leaves the state table
// untouched, so the flip retriggers cleanly on the next attempt.
async function detectCanonicalCourseFlip(
  sql: Sql,
  email: string,
  newCanonicalCourseId: string | null,
): Promise<{ flipped: boolean; previousCourseId: string | null }> {
  if (!email) return { flipped: false, previousCourseId: null };
  const rows = await sql<Array<{ last_canonical_course_id: string | null }>>`
    SELECT last_canonical_course_id
      FROM crm.brevo_contact_state
     WHERE email_lower = lower(${email})
     LIMIT 1
  `;
  const previousCourseId = rows[0]?.last_canonical_course_id ?? null;
  // First-time lead (no row): not a flip, leave SW_PENDING_RESTART untouched.
  if (rows.length === 0) return { flipped: false, previousCourseId: null };
  return {
    flipped: previousCourseId !== newCanonicalCourseId,
    previousCourseId,
  };
}

async function recordCanonicalCourse(
  sql: Sql,
  email: string,
  newCanonicalCourseId: string | null,
): Promise<void> {
  if (!email) return;
  await sql`
    INSERT INTO crm.brevo_contact_state (email_lower, last_canonical_course_id, updated_at)
    VALUES (lower(${email}), ${newCanonicalCourseId}, NOW())
    ON CONFLICT (email_lower)
    DO UPDATE SET
      last_canonical_course_id = EXCLUDED.last_canonical_course_id,
      updated_at = EXCLUDED.updated_at
  `;
}

// Builds the referral page URL for the referrer. The /refer/ page shows the
// referrer their personal sharing link. The ?ref= param tells the page which
// referrer this is. Funding category is irrelevant here — the refer page is
// for the referrer, not the friend they're sending the link to.
function buildReferralUrl(
  _fundingCategory: string | null,
  referralCode: string | null,
): string {
  const base = "https://switchable.org.uk/refer/";
  return referralCode
    ? `${base}?ref=${encodeURIComponent(referralCode)}`
    : base;
}

// Per-contact deep-link into the fastrack form on the funded thank-you page.
// Used by SW_FASTRACK_URL Brevo attribute (Wren ask 2026-05-09) so funded
// nurture v2's fastrack-push automation can link learners straight to their
// fastrack form with parent submission context resolved via client_nonce.
//
// Mirrors the exact URL shape the funded form's own thank-you redirect
// emits (`/funded/thank-you/?ref=<nonce>&course=<slug>&m=<0|1>`). The
// thank-you page's schedule/copy rendering reads `?course=` against
// matrix.json — without it the page falls back to "to be confirmed"
// even when a parent submission exists. The earlier (2026-05-09)
// shape-only ?ref= URL was therefore broken for any click from a Brevo
// broadcast or admin-pasted link. Fixed 2026-05-11.
//
// Returns empty string when client_nonce is missing (legacy pre-0087 rows
// or non-funded submissions). Brevo template should gate rendering on the
// attribute being non-empty.
function buildFastrackUrl(
  clientNonce: string | null,
  courseId: string | null,
  marketingOptIn: boolean,
): string {
  if (!clientNonce) return "";
  const params = [`ref=${encodeURIComponent(clientNonce)}`];
  if (courseId) params.push(`course=${encodeURIComponent(courseId)}`);
  params.push(`m=${marketingOptIn ? "1" : "0"}`);
  return `https://switchable.org.uk/funded/thank-you/?${params.join("&")}`;
}

// Resolves course / region / intake / sector for a submission, branching on
// funding_category. Self-funded leads skip matrix.json entirely (their
// course_id is a YAML id, not a page slug, so the lookup would silently miss)
// and read sector from submission.interest. Funded (gov/loan) leads go
// through matrix.json as before.
//
// Returned values are always strings (empty when not applicable) so the caller
// can drop them straight into Brevo attributes without null-handling.
async function composeBrevoCourseContext(submission: SubmissionRow): Promise<{
  courseTitle: string;
  courseSlug: string;
  intakeId: string;
  intakeDate: string;
  regionName: string;
  sector: string;
  courseSchedule: string;
  // True when the canonical course is still accepting applications. Self-funded
  // submissions stay true (rolling enrolment — never "closed" in the funded
  // sense). Funded routes inherit from matrix.json's acceptingApplications
  // field; default true if the field isn't surfaced yet.
  courseOpen: boolean;
}> {
  if (submission.funding_category === "self") {
    return {
      courseTitle: "",
      courseSlug: "",
      intakeId: "",
      intakeDate: "",
      regionName: "",
      sector: submission.interest ?? "",
      courseSchedule: "",
      courseOpen: true,
    };
  }

  const matrix = await getMatrixContext(submission.course_id, submission.preferred_intake_id);

  // SW_SECTOR maps to the course's interest tag in the funding-appropriate
  // taxonomy. Funded leads (gov) read ffInterest (free-courses-for-jobs
  // categorisation). Loan-funded reads cfInterest (course-finder
  // categorisation). Falls back to the other side if the primary is missing.
  const sector = submission.funding_category === "gov"
    ? (matrix.ffInterest ?? matrix.cfInterest)
    : (matrix.cfInterest ?? matrix.ffInterest);

  return {
    courseTitle: matrix.courseTitle ?? submission.course_id ?? "",
    courseSlug: matrix.courseId ?? "",
    intakeId: matrix.intakeId ?? "",
    intakeDate: matrix.intakeDate ?? "",
    regionName: matrix.regionName ?? "",
    sector: sector ?? "",
    courseSchedule: matrix.courseSchedule ?? "",
    courseOpen: matrix.courseAcceptingApplications,
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
// Returns { ok, error? } so callers that care about success can branch on it
// (admin-brevo-resync reports per-id status; route-lead's auto/owner paths
// ignore it because routing is already committed and Brevo is best-effort).
// Failure also logs a leads.dead_letter row regardless of caller behaviour.
// Pure attribute builder for the matched-path Brevo upsert. Used by:
//   1. upsertLearnerInBrevo, the canonical write path
//   2. brevo-attribute-reconcile, the per-attribute drift reconciler
// Same shape on both sides so the reconciler's projection is the same set
// of values that the live upsert would produce. Any future field added to
// the matched attributes goes here and both call sites pick it up.
export async function buildLearnerBrevoAttributes(
  sql: Sql,
  provider: ProviderRow,
  submission: SubmissionRow,
): Promise<BrevoAttributes> {
  const ctx = await composeBrevoCourseContext(submission);
  const dqReason = submission.is_dq ? (submission.dq_reason ?? "") : "";
  const agg = await loadEmailAggregateState(sql, submission.email ?? "");

  // SW_ENROL_STATUS reads crm.enrolments.status for this (submission, provider)
  // pair. LEFT JOIN-equivalent: if no row (race condition on resync paths
  // where the enrolment row hasn't materialised yet, or future no-row edge
  // cases), push empty string. Per migration 0042 every routed lead has a row
  // at routing time, so in practice this is always populated for the matched
  // path. Brevo Category accepts empty string for unset. The attribute lets
  // marketing automation segment by lifecycle (open / enrolled / etc.) so
  // re-engagement campaigns can target only open leads.
  let enrolStatus = "";
  let lostReason = "";
  try {
    const [enrolRow] = await sql<Array<{ status: string; lost_reason: string | null }>>`
      SELECT status, lost_reason
        FROM crm.enrolments
       WHERE submission_id = ${submission.id}
         AND provider_id   = ${provider.provider_id}
       LIMIT 1
    `;
    enrolStatus = enrolRow?.status ?? "";
    lostReason = enrolRow?.lost_reason ?? "";
  } catch (err) {
    console.error("crm.enrolments.status read failed:", String(err));
    // Continue with empty strings; one missing attribute shouldn't sink the upsert.
  }

  const contactValues = renderProviderContactValues(provider, submission);

  // Attribute namespacing: FIRSTNAME / LASTNAME stay as unprefixed Brevo
  // defaults (built-in fields). Everything Switchable-specific carries an
  // SW_ prefix so it doesn't collide with future SwitchLeads SL_-prefixed
  // attributes on the same Brevo contact (one email = one Brevo contact
  // across both brands). Decision 2026-04-29.
  return {
    FIRSTNAME: submission.first_name ?? "",
    LASTNAME: submission.last_name ?? "",
    SW_COURSE_NAME: ctx.courseTitle,
    SW_COURSE_SLUG: ctx.courseSlug,
    SW_COURSE_SCHEDULE: ctx.courseSchedule,
    SW_COURSE_INTAKE_ID: ctx.intakeId,
    SW_COURSE_INTAKE_DATE: ctx.intakeDate,
    // Course-state flag (Wren push 2026-05-25). True when the canonical
    // course is still accepting applications, false when closed. Read from
    // matrix.json's acceptingApplications via composeBrevoCourseContext.
    // Drives the N1-N3 "course closed" exit condition so contacts exit
    // cleanly when the course they're nurtured against shuts intake.
    SW_COURSE_OPEN: ctx.courseOpen,
    SW_REGION_NAME: ctx.regionName,
    SW_SECTOR: ctx.sector,
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
    SW_DQ_REASON: dqReason,
    SW_CONSENT_MARKETING: submission.marketing_opt_in,
    // SW_MATCH_STATUS lets Brevo Automations trigger off attribute updates
    // without needing a separate event API. See _shared/brevo.ts comment.
    SW_MATCH_STATUS: "matched",
    SW_ENROL_STATUS: mapEnrolStatusForBrevo(enrolStatus),
    // Email-aggregated: stays stable across this email's submissions so the
    // duplicate-submission overwrite never empties them. See
    // loadEmailAggregateState above.
    SW_REFERRAL_CODE: agg.referralCode ?? "",
    SW_REFERRAL_URL: buildReferralUrl(submission.funding_category ?? null, agg.referralCode),
    // Migration 0099 attributes. SW_PHONE for outreach/SMS targeting.
    // SW_LOST_REASON mirrors crm.enrolments.lost_reason so marketing can
    // segment lost reasons (cohort_decline / l3_mismatch / etc.).
    // SW_FASTRACK_COMPLETED + SW_FASTRACK_URL both read from the canonical
    // submission (see loadEmailAggregateState). Per-course not per-contact —
    // a re-applicant on a new course shows COMPLETED=false until they
    // fastrack on that course. URL uses the same canonical opt-in submission.
    // The 4 enrichment fields come from waitlist-enrichment after a
    // cohort_decline or generic /waitlist/ submit — populated on the
    // parent row via the ingest UPDATE step.
    SW_PHONE: submission.phone ?? "",
    SW_LOST_REASON: lostReason,
    SW_FASTRACK_COMPLETED: agg.canonicalFastracked,
    SW_FASTRACK_URL: buildFastrackUrl(agg.clientNonce, agg.courseId, agg.marketingOptIn === true),
    SW_START_TIMING: submission.start_timing ?? "",
    SW_INTEREST_BREADTH: submission.interest_breadth ?? "",
    SW_INVESTMENT_WILLINGNESS: submission.investment_willingness ?? "",
    SW_CURRENT_QUALIFICATION: submission.current_qualification ?? "",
    // U1 funded "what's next" block, split into three plain-text parts so
    // the template can wrap <strong> around the phone. See
    // renderProviderContactValues for the regional-vs-fallback logic.
    SW_PROVIDER_CONTACT_BEFORE: contactValues.before,
    SW_PROVIDER_PHONE: contactValues.phone,
    SW_PROVIDER_CONTACT_AFTER: contactValues.after,
    // First-name-only with dual fallback per Wren S18 (regional rep → provider
    // contact first word). Powers SMS bodies in _shared/sms-utility.ts and is
    // available to any future Brevo template that wants a personable rep name
    // without the split-filter trick currently used by chaser_funded.
    SW_PROVIDER_REP_FIRST_NAME: resolveRepFirstName(provider, submission),
  };
}

export async function upsertLearnerInBrevo(
  sql: Sql,
  provider: ProviderRow,
  submission: SubmissionRow,
): Promise<{ ok: boolean; error?: string }> {
  if (!submission.email) return { ok: false, error: "submission has no email" };

  // Both list IDs are optional. Utility list-add is legacy post the 2026-05-07
  // transactional cutover (utility emails fire via Brevo Transactional API,
  // not list automations); the env var stays during the 90-day retention
  // window (~delete 2026-08-06) so existing membership doesn't drift before
  // the list is deleted. Marketing list-add is consent-gated by
  // submission.marketing_opt_in. If both env vars are unset, the contact
  // upsert still fires (attributes + channel state) but with no list
  // membership change — Brevo handles empty listIds.
  const utilityListId = parseEnvInt("BREVO_LIST_ID_SWITCHABLE_UTILITY");
  const marketingListId = parseEnvInt("BREVO_LIST_ID_SWITCHABLE_MARKETING");

  const attributes = await buildLearnerBrevoAttributes(sql, provider, submission);

  // SW_PENDING_RESTART (Wren push 2026-05-25): course-flip detection. Reads
  // crm.brevo_contact_state for the previously-stored canonical course and
  // sets the attribute when it differs. The canonical course id is the same
  // value already driving SW_COURSE_NAME etc. in the attribute object
  // (loadEmailAggregateState resolves it once per build). First-time leads
  // skip this — there's no row to compare against. Failures in detect or
  // record don't block the upsert: a missed flip is acceptable, a missed
  // Brevo write is not.
  let flipDetected = false;
  const canonicalAgg = await loadEmailAggregateState(sql, submission.email);
  try {
    const { flipped } = await detectCanonicalCourseFlip(
      sql, submission.email, canonicalAgg.courseId,
    );
    flipDetected = flipped;
    if (flipped) attributes.SW_PENDING_RESTART = true;
  } catch (err) {
    console.error("detectCanonicalCourseFlip failed (non-blocking):", String(err));
  }

  // One upsert call adds the contact to both lists atomically. Previously
  // this was a two-call sequence (upsert + addContactToList) which raced
  // against Brevo's backend and surfaced the misleading "Contact already in
  // list and/or does not exist" 400. Single call eliminates the race.
  const listIds: number[] = [];
  if (utilityListId != null) listIds.push(utilityListId);
  if (submission.marketing_opt_in && marketingListId != null) {
    listIds.push(marketingListId);
  }

  const upsertResult = await upsertBrevoContact({
    email: submission.email,
    attributes,
    listIds,
    marketingOptIn: submission.marketing_opt_in ?? null,
  });

  if (!upsertResult.ok) {
    await persistDeadLetter(sql, "edge_function_brevo_upsert",
      { provider_id: provider.provider_id, submission_id: submission.id },
      `Brevo learner upsert failed: ${upsertResult.error ?? "unknown"}`);
    return { ok: false, error: upsertResult.error ?? "unknown" };
  }

  // Record the canonical course as "last pushed" only after the Brevo write
  // succeeds. On failure we leave the previous state intact so the next
  // retry re-detects the same flip and re-fires SW_PENDING_RESTART.
  try {
    await recordCanonicalCourse(sql, submission.email, canonicalAgg.courseId);
  } catch (err) {
    console.error("recordCanonicalCourse failed (non-blocking):", String(err));
  }
  if (flipDetected) {
    console.log(`upsertLearnerInBrevo: SW_PENDING_RESTART=true for ${submission.email} (canonical course flipped to ${canonicalAgg.courseId ?? 'null'})`);
  }
  return { ok: true };
}

// Build the three plain-text values for the "what's next" block on the
// U1 funded ack. The U1 funded template wraps them as:
//   <p>{{contact.SW_PROVIDER_CONTACT_BEFORE}} <strong>{{contact.SW_PROVIDER_PHONE}}</strong> {{contact.SW_PROVIDER_CONTACT_AFTER}}</p>
// HTML wrapper lives in the template because Brevo's text-type
// contact attributes are always escape-rendered (the `| raw` filter
// throws a syntax error; the only template-side workaround is to
// keep variables plain-text and put the markup in static template
// content). Brevo handles HTML-escape on `{{contact.X}}` substitution
// so we push raw text without pre-escaping.
//
// Two shapes:
//   1. Regional match: provider.regional_contacts.by_la has an entry for
//      submission.la. before/phone/after split out so the template can
//      bold the phone number.
//   2. No match (every non-EMS provider, an EMS lead with an LA outside
//      the mapping, or a pre-routing / unmatched lead with no provider):
//      `before` carries the unified fallback sentence; `phone` + `after`
//      are empty so the template's <strong></strong> renders invisibly.
//
// Provider is nullable for the no_match / pending paths where no provider
// exists yet — only the fallback branch fires.
// Resolve the named-rep first name for SMS bodies + Brevo attribute. Dual
// fallback per Wren's S18 design:
//   1. Regional rep first_name (provider.regional_contacts.by_la[submission.la])
//   2. Provider's main contact_name first word
//   3. Empty string (caller decides whether to skip the SMS)
// Used by buildLearnerBrevoAttributes (pushes SW_PROVIDER_REP_FIRST_NAME) and
// by _shared/sms-utility.ts (renders the {{REP_FIRST_NAME}} merge field).
export function resolveRepFirstName(
  provider: ProviderRow | null,
  submission: SubmissionRow,
): string {
  if (!provider) return "";
  const la = submission.la;
  const regional = la ? provider.regional_contacts?.by_la?.[la] : undefined;
  if (regional?.first_name) return regional.first_name;
  if (provider.contact_name) {
    const first = provider.contact_name.trim().split(/\s+/)[0];
    if (first) return first;
  }
  return "";
}

export function renderProviderContactValues(
  provider: ProviderRow | null,
  submission: SubmissionRow,
): { before: string; phone: string; after: string } {
  const la = submission.la;
  const contact = la && provider ? provider.regional_contacts?.by_la?.[la] : undefined;
  if (contact && provider) {
    return {
      before: `${contact.first_name} from ${provider.company_name} will give you a call to talk it through. Spaces fill fast, so save`,
      phone: contact.phone,
      after: "in your contacts now and pick up when it rings.",
    };
  }
  return {
    before: "They'll be in touch within the next few days by email or phone to talk you through your start date and answer anything you want to ask.",
    phone: "",
    after: "",
  };
}

// Phase 2a U1 send. Composes the per-send template params from the same matrix
// + submission shape that upsertLearnerInBrevo uses (so contact attributes and
// transactional params stay consistent), routes to U1_FUNDED vs U1_SELF based
// on funding_category, and delegates idempotency / retry / dead_letter to
// sendTransactional. Single funded template — the prior pre-fastrack /
// post-fastrack split was retired 2026-05-16 (Wren) because the regular U1
// copy already accommodates fastracked learners and the post-fastrack "thanks
// for sending the extra details" beat duplicates the site thank-you ack.
// Best-effort: missing template env, missing email, or null funding_category
// all skip silently. Re-applications skip too — the parent submission already
// received U1, the new submission_id would otherwise pass the per-submission
// idempotency check and double-send.
async function sendU1Transactional(
  sql: Sql,
  provider: ProviderRow,
  submission: SubmissionRow,
  trigger: RouteTrigger,
): Promise<void> {
  if (trigger === "re_application") return;
  if (!submission.email) return;
  if (!submission.funding_category) {
    console.error(`U1 skipped for submission ${submission.id}: funding_category null`);
    return;
  }

  // Three welcome variants by route:
  //   - funded (gov/loan, not paying): "your funded place" framing
  //   - private (paying, came through a funded page): single-course + payment
  //     framing (u1_private)
  //   - self (everything else): multi-course self-funded framing
  const isPrivate = submission.pay_route === "private";
  const isFunded =
    (submission.funding_category === "gov" || submission.funding_category === "loan") &&
    !isPrivate;

  let templateEnvName: string;
  let emailType: "u1_funded" | "u1_self" | "u1_private";
  if (isPrivate) {
    templateEnvName = "BREVO_TEMPLATE_U1_PRIVATE";
    emailType = "u1_private";
  } else if (isFunded) {
    templateEnvName = "BREVO_TEMPLATE_U1_FUNDED";
    emailType = "u1_funded";
  } else {
    templateEnvName = "BREVO_TEMPLATE_U1_SELF";
    emailType = "u1_self";
  }

  let templateId = parseEnvInt(templateEnvName);
  // The private welcome falls back to the self-funded template until the bespoke
  // u1_private template is built in Brevo and BREVO_TEMPLATE_U1_PRIVATE is set —
  // private payers still get a sensible paying-learner email (logged as
  // u1_private) in the meantime, and it auto-upgrades once the env is set.
  if (templateId == null && isPrivate) {
    templateId = parseEnvInt("BREVO_TEMPLATE_U1_SELF");
  }
  if (templateId == null) {
    // Silently skip if the U1 template env var isn't set — no dead_letter
    // spam during shadow setup or template-rebuild windows. Live in
    // production since the 2026-05-07 cutover.
    return;
  }

  const ctx = await composeBrevoCourseContext(submission);

  const params: Record<string, string | number | boolean | null> = {
    FIRSTNAME: submission.first_name ?? "",
    LASTNAME: submission.last_name ?? "",
    SW_COURSE_NAME: ctx.courseTitle,
    SW_COURSE_SLUG: ctx.courseSlug,
    SW_COURSE_SCHEDULE: ctx.courseSchedule,
    SW_COURSE_INTAKE_ID: ctx.intakeId,
    SW_COURSE_INTAKE_DATE: ctx.intakeDate,
    SW_REGION_NAME: ctx.regionName,
    SW_SECTOR: ctx.sector,
    SW_PROVIDER_NAME: provider.company_name,
    SW_PROVIDER_TRUST_LINE: provider.trust_line ?? "",
    SW_FUNDING_CATEGORY: submission.funding_category,
    SW_FUNDING_ROUTE: submission.funding_route ?? "",
    SW_REFERRAL_CODE: submission.referral_code ?? "",
    SW_REFERRAL_URL: buildReferralUrl(submission.funding_category ?? null, submission.referral_code),
    // Migration 0099 fields (also passed as template params for any U1
    // template that wants to render them). Empty string for missing values
    // to keep template renderers safe.
    SW_PHONE: submission.phone ?? "",
    SW_FASTRACK_COMPLETED: submission.fastracked_at != null,
    SW_FASTRACK_URL: buildFastrackUrl(submission.client_nonce, submission.course_id, submission.marketing_opt_in === true),
    SW_START_TIMING: submission.start_timing ?? "",
    SW_INTEREST_BREADTH: submission.interest_breadth ?? "",
    SW_INVESTMENT_WILLINGNESS: submission.investment_willingness ?? "",
    SW_CURRENT_QUALIFICATION: submission.current_qualification ?? "",
  };

  const recipientName = [submission.first_name, submission.last_name]
    .filter(Boolean)
    .join(" ") || undefined;

  const result = await sendTransactional({
    sql,
    templateId,
    recipient: { email: submission.email, name: recipientName },
    params,
    submissionId: submission.id,
    emailType,
    brand: "switchable",
    tags: ["u1", emailType, trigger],
  });

  if (!result.ok && result.status === "failed") {
    // sendTransactional already wrote the email_log + dead_letter rows.
    console.error(`U1 send failed for submission ${submission.id}: ${result.error ?? "unknown"}`);
  }
}

// Same Brevo upsert as upsertLearnerInBrevo, minus the provider attributes,
// for unmatched (no_match / pending) leads. Provider attrs stay empty;
// SW_MATCH_STATUS carries the state. Brevo Automation entry filters branch
// the nurture from there:
//   - matched + funded     -> N1-N7 spine + monthly newsletter
//   - matched + self       -> U-track utility only (sector-led nurture future)
//   - pending              -> SF13 "picking your provider", flips to matched on confirm
//   - no_match             -> SF8 recirc utility, then monthly newsletter only
//
// Takes a submission id rather than a row so callers (netlify-lead-router
// post-insert, admin-brevo-resync historical backfill) don't have to assemble
// the SubmissionRow shape themselves. Fetches with the same column list as
// fetchSubmission inside routeLead so the two helpers stay aligned.
//
// Same best-effort posture as the matched helper: failure logs to
// leads.dead_letter and returns. The submission is already committed by the
// caller, so Brevo failure doesn't unwind anything.
// Same column list as fetchSubmission inside routeLead so the helpers stay
// aligned. Exposed so the Brevo reconciler can pull a submission row once
// and feed both build helpers without duplicating the SELECT.
export const SUBMISSION_FULL_COLUMNS = `id, submitted_at, course_id, funding_category, funding_route,
       first_name, last_name, email, phone,
       la, region_scheme, age_band, employment_status,
       prior_level_3_or_higher, can_start_on_intake_date,
       outcome_interest, why_this_course, earnings_band,
       postcode, region, reason, interest, situation,
       qualification, start_when, budget, courses_selected,
       is_dq, dq_reason, primary_routed_to, archived_at,
       marketing_opt_in,
       preferred_intake_id, acceptable_intake_ids,
       referral_code, client_nonce,
       start_timing, interest_breadth, investment_willingness,
       current_qualification, source_form, enriched_at,
       fastracked_at`;

// Pure attribute builder for the no_match / pending paths. Same role as
// buildLearnerBrevoAttributes for the matched path — used by both the
// canonical upsertLearnerInBrevoNoMatch write path and the per-attribute
// drift reconciler so the projection sees the same shape the upsert would
// produce.
export async function buildLearnerBrevoAttributesNoMatch(
  sql: Sql,
  submission: SubmissionRow,
  matchStatus: "no_match" | "pending",
): Promise<BrevoAttributes> {
  const ctx = await composeBrevoCourseContext(submission);
  const dqReason = submission.is_dq ? (submission.dq_reason ?? "") : "";
  const agg = await loadEmailAggregateState(sql, submission.email ?? "");

  return {
    FIRSTNAME: submission.first_name ?? "",
    LASTNAME: submission.last_name ?? "",
    SW_COURSE_NAME: ctx.courseTitle,
    SW_COURSE_SLUG: ctx.courseSlug,
    SW_COURSE_SCHEDULE: ctx.courseSchedule,
    SW_COURSE_INTAKE_ID: ctx.intakeId,
    SW_COURSE_INTAKE_DATE: ctx.intakeDate,
    // Course-state flag (Wren push 2026-05-25). Same source + meaning as
    // the matched builder; mirrored here so no_match / pending contacts get
    // a consistent SW_COURSE_OPEN attribute regardless of routing state.
    SW_COURSE_OPEN: ctx.courseOpen,
    SW_REGION_NAME: ctx.regionName,
    SW_SECTOR: ctx.sector,
    SW_PROVIDER_NAME: "",
    SW_PROVIDER_TRUST_LINE: "",
    SW_FUNDING_CATEGORY: submission.funding_category ?? "",
    SW_FUNDING_ROUTE: submission.funding_route ?? "",
    SW_EMPLOYMENT_STATUS: submission.employment_status ?? "",
    SW_OUTCOME_INTEREST: submission.outcome_interest ?? "",
    SW_DQ_REASON: dqReason,
    SW_CONSENT_MARKETING: submission.marketing_opt_in,
    SW_MATCH_STATUS: matchStatus,
    // SW_ENROL_STATUS is empty for no_match / pending — these contacts aren't
    // in the enrolment lifecycle yet. Will be populated once the lead routes
    // and the matched upsert helper takes over.
    SW_ENROL_STATUS: "",
    // Email-aggregated (see loadEmailAggregateState). Keeps the URL +
    // fastracked-flag attributes stable across this email's submissions.
    SW_REFERRAL_CODE: agg.referralCode ?? "",
    SW_REFERRAL_URL: buildReferralUrl(submission.funding_category ?? null, agg.referralCode),
    // Migration 0099 attributes (kept consistent across no_match / pending /
    // matched lifecycle states so the contact record doesn't reshape on
    // transition). SW_LOST_REASON is empty here because no enrolment row
    // exists yet for these contacts.
    SW_PHONE: submission.phone ?? "",
    SW_LOST_REASON: "",
    SW_FASTRACK_COMPLETED: agg.canonicalFastracked,
    SW_FASTRACK_URL: buildFastrackUrl(agg.clientNonce, agg.courseId, agg.marketingOptIn === true),
    SW_START_TIMING: submission.start_timing ?? "",
    SW_INTEREST_BREADTH: submission.interest_breadth ?? "",
    SW_INVESTMENT_WILLINGNESS: submission.investment_willingness ?? "",
    SW_CURRENT_QUALIFICATION: submission.current_qualification ?? "",
    // No provider on no_match / pending paths, so before carries the unified
    // fallback sentence and phone/after stay empty. Populated for consistency
    // so the three attributes are present on every Switchable contact.
    SW_PROVIDER_CONTACT_BEFORE: renderProviderContactValues(null, submission).before,
    SW_PROVIDER_PHONE: "",
    SW_PROVIDER_CONTACT_AFTER: "",
  };
}

export async function upsertLearnerInBrevoNoMatch(
  sql: Sql,
  submissionId: number,
  matchStatus: "no_match" | "pending",
): Promise<{ ok: boolean; error?: string }> {
  const [submission] = await sql<SubmissionRow[]>`
    SELECT id, submitted_at, course_id, funding_category, funding_route,
           first_name, last_name, email, phone,
           la, region_scheme, age_band, employment_status,
           prior_level_3_or_higher, can_start_on_intake_date,
           outcome_interest, why_this_course, earnings_band,
           postcode, region, reason, interest, situation,
           qualification, start_when, budget, courses_selected,
           is_dq, dq_reason, primary_routed_to, archived_at,
           marketing_opt_in,
           preferred_intake_id, acceptable_intake_ids,
           referral_code,
           start_timing, interest_breadth, investment_willingness,
           current_qualification, source_form, enriched_at,
           fastracked_at
      FROM leads.submissions
     WHERE id = ${submissionId}
     LIMIT 1
  `;
  if (!submission) return { ok: false, error: "submission not found" };
  if (submission.archived_at) return { ok: false, error: "submission archived" };
  if (!submission.email) return { ok: false, error: "submission has no email" };

  // Both list IDs optional — see upsertLearnerInBrevo for the post-cutover
  // rationale (utility list-add is legacy, kept during 90-day retention).
  const utilityListId = parseEnvInt("BREVO_LIST_ID_SWITCHABLE_UTILITY");
  const marketingListId = parseEnvInt("BREVO_LIST_ID_SWITCHABLE_MARKETING");
  // Newsletter list (id 10). Owner decision 2026-05-31: not-routed (no_match)
  // leads who consented to marketing go straight onto the newsletter list, not
  // only the marketing list, so they receive the newsletter without waiting on a
  // separate Brevo graduation automation. Gated on marketing_opt_in below — the
  // newsletter is a marketing communication, so consent applies (unlike the
  // newsletter signup form, where the submit itself is the consent). Routed
  // leads are deliberately excluded: their nurture sequences place them.
  const newsletterListId = parseEnvInt("BREVO_LIST_ID_SWITCHABLE_NEWSLETTER");

  const attributes = await buildLearnerBrevoAttributesNoMatch(sql, submission, matchStatus);

  // SW_PENDING_RESTART flip detection — mirrors upsertLearnerInBrevo. See
  // that function for the rationale. Same pattern: read state → maybe set
  // attribute → upsert → record on success.
  let flipDetected = false;
  const canonicalAgg = await loadEmailAggregateState(sql, submission.email);
  try {
    const { flipped } = await detectCanonicalCourseFlip(
      sql, submission.email, canonicalAgg.courseId,
    );
    flipDetected = flipped;
    if (flipped) attributes.SW_PENDING_RESTART = true;
  } catch (err) {
    console.error("detectCanonicalCourseFlip failed (non-blocking):", String(err));
  }

  const listIds: number[] = [];
  if (utilityListId != null) listIds.push(utilityListId);
  if (submission.marketing_opt_in && marketingListId != null) {
    listIds.push(marketingListId);
  }
  if (submission.marketing_opt_in && newsletterListId != null) {
    listIds.push(newsletterListId);
  }

  const upsertResult = await upsertBrevoContact({
    email: submission.email,
    attributes,
    listIds,
    marketingOptIn: submission.marketing_opt_in ?? null,
  });

  if (!upsertResult.ok) {
    await persistDeadLetter(sql, "edge_function_brevo_upsert_no_match",
      { submission_id: submission.id, match_status: matchStatus },
      `Brevo learner upsert (${matchStatus}) failed: ${upsertResult.error ?? "unknown"}`);
    return { ok: false, error: upsertResult.error ?? "unknown" };
  }

  try {
    await recordCanonicalCourse(sql, submission.email, canonicalAgg.courseId);
  } catch (err) {
    console.error("recordCanonicalCourse failed (non-blocking):", String(err));
  }
  if (flipDetected) {
    console.log(`upsertLearnerInBrevoNoMatch (${matchStatus}): SW_PENDING_RESTART=true for ${submission.email} (canonical course flipped to ${canonicalAgg.courseId ?? 'null'})`);
  }
  return { ok: true };
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
    pay_route: lc(submission.pay_route),
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
    earnings_band: lc(submission.earnings_band),
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

  // Apps Script always returns HTTP 200 even on token failures, redeploy
  // permission lapses, and logic errors — the only reliable success signal
  // is a parseable JSON body with ok===true. A non-JSON response (HTML
  // auth page, redirect, plain text) is ALWAYS a failure, never a success.
  // Previously `catch { return { ok: true }; }` swallowed those, which is
  // how submission 267 (Christy Clarence, 2026-05-04) was recorded as
  // delivered to the EMS sheet but never actually landed there.
  const responseText = await res.text();
  let body: { ok?: boolean; error?: string };
  try {
    body = JSON.parse(responseText) as { ok?: boolean; error?: string };
  } catch {
    return {
      ok: false,
      error: `apps script: unparseable response: ${responseText.slice(0, 300)}`,
    };
  }
  if (body.ok === true) return { ok: true };
  return { ok: false, error: body.error ?? "apps script returned ok=false" };
}

// -------- CRM webhook push --------

// Posts the lead payload to the provider's external CRM webhook URL
// (e.g. HubSpot Forms API submission URL, Zapier catch hook, Make.com).
// Pure JSON, no auth — provider URLs are unguessable per-provider tokens.
// Mirrors the appender's payload but flattens to a name/value pair shape
// that HubSpot Forms accepts natively (most providers' tooling accepts
// either flat fields or HubSpot's array shape, so we send both).
//
// Compatibility note for HubSpot Forms API:
//   POST https://api.hsforms.com/submissions/v3/integration/submit/{portalId}/{formGuid}
//   Body shape required: { "fields": [{ "name": "...", "value": "..." }, ...] }
//
// Other receivers (Zapier, Make, custom) usually accept either. We send
// both `fields[]` (HubSpot shape) and the flat object so providers don't
// need to massage the payload at the receiver.
async function pushToProviderCrm(
  provider: ProviderRow,
  submission: SubmissionRow,
  courseTitle: string | null,
  status: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!provider.crm_webhook_url) return { ok: true };

  const leadId = formatLeadId(submission.id, submission.submitted_at);
  const flat: Record<string, string | number | null> = {
    lead_id: leadId,
    switchleads_lead_id: leadId,
    submission_id: submission.id,
    submitted_at: submission.submitted_at,
    name: [submission.first_name, submission.last_name].filter(Boolean).join(" ") || null,
    first_name: submission.first_name ?? null,
    last_name: submission.last_name ?? null,
    email: submission.email ?? null,
    phone: submission.phone ?? null,

    // Funded shape (gov / loan)
    course_id: submission.course_id ?? null,
    course_title: courseTitle ?? null,
    funding_category: submission.funding_category ?? null,
    funding_route: submission.funding_route ?? null,
    age_band: submission.age_band ?? null,
    employment_status: submission.employment_status ?? null,
    why_this_course: submission.why_this_course ?? null,
    outcome_interest: submission.outcome_interest ?? null,

    // Self-funded shape (Courses Direct etc.)
    courses_selected: submission.courses_selected?.join(", ") ?? null,
    region: submission.region ?? null,
    postcode: submission.postcode ?? null,
    interest: submission.interest ?? null,
    reason: submission.reason ?? null,
    budget: submission.budget ?? null,
    situation: submission.situation ?? null,
    qualification: submission.qualification ?? null,
    readiness: submission.start_when ?? null,

    // Routing context
    provider_id: provider.provider_id,
    provider_company: provider.company_name,
    status,
  };

  const fields = Object.entries(flat)
    .filter(([, v]) => v !== null && v !== "")
    .map(([name, value]) => ({ name, value: String(value) }));

  const payload = { ...flat, fields };

  let res: Response;
  try {
    res = await fetch(provider.crm_webhook_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, error: `fetch failed: ${String(err)}` };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "<body unreadable>");
    return { ok: false, error: `crm webhook ${res.status}: ${text.slice(0, 300)}` };
  }
  return { ok: true };
}

// -------- Emails --------

export async function sendProviderNotification(
  sql: Sql,
  provider: ProviderRow,
  submission: SubmissionRow,
  trigger: RouteTrigger,
  reApplicationContext?: ReApplicationContext,
): Promise<{ ok: boolean; error?: string }> {
  const leadId = formatLeadId(submission.id, submission.submitted_at);
  const sheetLink = provider.sheet_id
    ? `https://docs.google.com/spreadsheets/d/${provider.sheet_id}/edit`
    : null;
  // Portal-enabled providers get a deep link into the portal lead detail.
  // The proxy on app.switchleads.co.uk rewrites /leads/<id> → /provider/leads/<id>.
  const portalLink = provider.portal_enabled
    ? `https://app.switchleads.co.uk/leads/${submission.id}`
    : null;

  const ownerEmail = getOwnerEmail();
  const providerUserCcs = await fetchAreaScopedProviderUsers(sql, provider.provider_id, submission.la);
  const ccList = buildCcList(ownerEmail, provider.cc_emails, providerUserCcs, provider.contact_email);

  // Action link block — portal as primary CTA when available, sheet
  // always rendered as a fallback link below it when present, so the
  // provider can still reach the lead if the portal misbehaves.
  const actionBlock = portalLink && sheetLink
    ? `<p><a href="${portalLink}">Open this lead in your SwitchLeads portal</a></p>
       <p style="font-size:13px;color:#64748b;">Backup: <a href="${sheetLink}">open your sheet</a> if the portal isn't loading.</p>`
    : portalLink
      ? `<p><a href="${portalLink}">Open this lead in your SwitchLeads portal</a></p>`
      : sheetLink
        ? `<p><a href="${sheetLink}">Open your sheet</a></p>`
        : "";

  // Re-application: PII-free, references the parent lead by its label.
  if (trigger === "re_application" && reApplicationContext) {
    const reAppContextLine = portalLink
      ? `<p>Open the lead in the portal — the re-application is logged in its history.</p>`
      : `<p>You'll see a new row at the bottom of your sheet with status <strong>Re-applied</strong>, referencing the original.</p>`;
    const html = `
      <p>Hello,</p>
      <p>A previous enquiry (${reApplicationContext.parentLeadId}) has just resubmitted the form.</p>
      ${actionBlock}
      ${reAppContextLine}
      <p>This is a positive engagement signal — they're still keen. Worth a follow-up if you haven't already, or update the status if you've spoken.</p>
      <p>Thanks,<br>SwitchLeads</p>
    `.trim();
    return await sendBrevoEmail({
      to: [{ email: provider.contact_email, name: provider.contact_name ?? provider.company_name }],
      cc: ccList.length > 0 ? ccList : undefined,
      subject: `Re-applied: ${reApplicationContext.parentLeadId}`,
      htmlContent: html,
      brand: "switchleads_leads",
      tags: ["route-lead", "re-application", "provider-notification"],
    });
  }

  // Standard new-enquiry email (auto-route + owner-confirm paths)
  const enquiryContextLine = portalLink
    ? `<p>The lead is at status <strong>open</strong>. Click through to see contact details, mark outcomes as you call, and add notes.</p>`
    : `<p>The lead has been added with status <strong>open</strong>. Please update the status and notes in your sheet as you work through the follow-up.</p>`;
  // Private-pay learners self-fund. PII-free flag so the provider knows to
  // bill the learner directly rather than enrol them as a funded place.
  const privatePayLine = submission.pay_route === "private"
    ? `<p style="margin:0;padding:12px 16px;background:#fff3cd;border:1px solid #e0c200;border-radius:6px;color:#664d03;"><strong>This learner is self-funding.</strong> They didn't qualify for funding and chose to pay, so enrol them as a paying student and bill them the course fee directly.</p>`
    : "";
  const html = `
    <p>Hello,</p>
    <p>You have a new enquiry (${leadId}) ${portalLink ? "ready in your SwitchLeads portal" : "in your SwitchLeads sheet"}.</p>
    ${actionBlock}
    ${enquiryContextLine}
    ${privatePayLine}
    <p>Thanks,<br>SwitchLeads</p>
  `.trim();

  return await sendBrevoEmail({
    to: [{ email: provider.contact_email, name: provider.contact_name ?? provider.company_name }],
    cc: ccList.length > 0 ? ccList : undefined,
    subject: `New enquiry - ${leadId}`,
    htmlContent: html,
    brand: "switchleads_leads",
    tags: ["route-lead", "provider-notification"],
  });
}

// Fetch provider_users CC recipients for a given (provider, lead-LA) pair.
// Active users only. notification_las NULL or empty = catch-all (always
// included). Non-empty = included only when submission.la is in the array.
// la=null on the submission falls back to catch-all matches only.
//
// Used by sendProviderNotification (new leads) and admin-notify-callback
// (callback notes) — same query, single source of truth for area routing.
export async function fetchAreaScopedProviderUsers(
  sql: Sql,
  providerId: string,
  la: string | null,
): Promise<Array<{ email: string; name?: string }>> {
  try {
    const rows = await sql<Array<{ contact_email: string; display_name: string | null }>>`
      SELECT contact_email, display_name
        FROM crm.provider_users
       WHERE provider_id = ${providerId}
         AND status      = 'active'
         AND (
           notification_las IS NULL
           OR cardinality(notification_las) = 0
           OR ${la}::text = ANY(notification_las)
         )
    `;
    return rows.map((r) => r.display_name
      ? { email: r.contact_email, name: r.display_name }
      : { email: r.contact_email });
  } catch (err) {
    console.error("fetchAreaScopedProviderUsers failed:", err);
    return [];
  }
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

  const ownerEmail = getOwnerEmail();
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

// Build the CC list, deduplicated against the TO address (if supplied)
// and against duplicate emails within CC. Order of preference:
//   1. Owner (Charlotte)
//   2. provider.cc_emails (free-form per-provider catch-all CCs)
//   3. provider_users matching the lead's LA scope (from fetchAreaScoped…)
// Returning [] is safe — sendBrevoEmail will omit the cc field.
export function buildCcList(
  ownerEmail: string | null | undefined,
  providerCcEmails: string[] | null,
  providerUserCcs: Array<{ email: string; name?: string }> = [],
  toEmail?: string,
): Array<{ email: string; name?: string }> {
  const seen = new Set<string>();
  if (toEmail) seen.add(toEmail.trim().toLowerCase());
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
  for (const cc of providerUserCcs) add(cc.email, cc.name);
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
    // Public-schema wrapper (migration 0147) over audit.log_system_action.
    // Works regardless of caller role context, so future SET LOCAL ROLE
    // additions inside this code path won't silently drop audit rows.
    await sql`
      SELECT public.log_system_action_v1(
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
