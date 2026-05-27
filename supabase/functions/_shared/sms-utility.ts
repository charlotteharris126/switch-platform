// Shared SMS utility helpers — Chunk 2 of the SMS utility build per
// switchable/email/docs/sms-utility-design.md (Wren, locked 2026-05-21).
//
// Two triggers wired in this chunk:
//   - Trigger B (save-number on qualify-PASS), fired from fastrack-receive
//     when cohort_confirmed=true AND l3_reconfirmed=false. Sister to the
//     existing u-fastrack-qualified email send.
//   - Trigger C (chaser on attempt_1_no_answer), fired from the server-
//     action `markOutcomeAction` chaser block via the RPC
//     `crm.fire_sms_chaser_attempt_1` → EF `sms-chaser-attempt-1`. Fires
//     ONCE per learner (not on attempt_2/3/cannot_reach — keeps volume
//     sane per Wren spec). Email chaser still fires on every attempt
//     status flip as today.
//
// Trigger A (fastrack-link cron) is Chunk 3 and uses its own bespoke gate
// + body — not in this module.
//
// Body templates live here as TS template strings (per spec: "bodies are
// passed as a string at API call time, NOT stored as numbered Brevo
// templates"). The rendered string is stored in crm.sms_log.body_rendered
// for post-hoc visibility.
//
// Voice notes per S18 decisions log (supersedes spec doc line 80-86):
//   - Chaser framing is prime-the-pickup, not call-back-CTA. Body says
//     "they'll try again, keep an eye out" — providers retain control of
//     calling cadence; we don't push learners to call random reps mid-day.
//   - Sign-off "Switchable" not "The Switchable team" — keeps every
//     worst-case render single-segment (160 chars).

import type { Sql } from "npm:postgres@3";
import {
  sendSms,
  type SendSmsResult,
  type SmsLogType,
} from "./brevo.ts";
import {
  getMatrixContext,
  renderProviderContactValues,
  resolveRepFirstName,
  type ProviderRow,
  type SubmissionRow,
} from "./route-lead.ts";

// Body templates. Worst-case render lengths in comments — every variant
// must come in under 160 chars to keep cost predictable.
const SAVE_NUMBER_BODY_TEMPLATE =
  "Hi {{FIRSTNAME}}, you've passed the stage 1 eligibility check. {{REP_FIRST_NAME}} will be in touch about your {{COURSE_NAME}} place soon. Save their number: {{PROVIDER_PHONE}}. Switchable";
// Worst-case: "Hi Catherine, you've passed the stage 1 eligibility check. George will be in touch about your Social Media for E-commerce place soon. Save their number: 01642 123456. Switchable" = 177 chars (just over single-segment — 2 segments worst case).

const CHASER_BODY_TEMPLATE =
  "Hi {{FIRSTNAME}}, {{REP_FIRST_NAME}} tried calling about your {{COURSE_NAME}} place. They'll try again, keep an eye out. Save their number: {{PROVIDER_PHONE}}. Switchable";
// Worst-case: "Hi Catherine, George tried calling about your Social Media for E-commerce place. They'll try again, keep an eye out. Save their number: 01642 123456. Switchable" = 161 chars (sits right on the 160 single-segment boundary — most renders fit, longest course names tip to 2 segments).

// Trigger A — fastrack-link prompt. Fires 10 minutes after routing for any
// matched lead that hasn't fastracked yet. Uses {{PROVIDER_NAME}} (company)
// rather than {{REP_FIRST_NAME}} because the rep hasn't tried to call yet
// at this point — naming them would be premature per spec.
//
// Short URL infra (`switchable.org.uk/f/{token}`) is a deferred handover to
// Mable. Until then this template renders the full fastrack URL inline,
// which is ~150 chars and pushes the worst-case render to ~240 chars (2 SMS
// segments). Cost ~2x per send during the interim. Acceptable for MVP volume;
// flagged in handoff for Mable to add the shortener.
const FASTRACK_LINK_BODY_TEMPLATE =
  "Hi {{FIRSTNAME}}, confirm your {{COURSE_NAME}} place with {{PROVIDER_NAME}}. Fastrack your application with this quick form: {{FASTRACK_URL}}. Switchable";
// Worst-case until Mable ships /f/{token}: ~270 chars (multi-segment).
// Target post-shortener: ~165 chars (still ~1-2 segments depending on course name length).

interface SmsGateResult {
  ok: boolean;
  /** Why the gate rejected the send. Populated when ok=false. */
  reason?: string;
}

export interface FireSmsArgs {
  sql: Sql;
  submission: SubmissionRow;
  provider: ProviderRow;
  /** Optional dedup window in hours. Passed through to sendSms. When set, the
   *  per-(submission_id, comm_type) idempotency check only blocks if a
   *  non-failed row landed within this many hours. Default (undefined) is
   *  once-ever, used by the auto-fire path. The bulk manual path passes 24. */
  cooldownHours?: number;
  /** Override the SMS log metadata.trigger_source. Default value per helper
   *  matches the auto-fire trigger; the bulk manual path passes
   *  'admin_bulk_chaser' so post-hoc inspection of sms_log can distinguish
   *  the two firing paths. */
  triggerSourceOverride?: string;
}

export type SmsHelperOutcome =
  | { kind: "sent"; result: SendSmsResult }
  | { kind: "skipped"; reason: string };

// --- Trigger B: save-number on qualify-PASS ---

export async function fireSaveNumberSms(args: FireSmsArgs): Promise<SmsHelperOutcome> {
  const gate = await runSharedGates(args.sql, args.submission, args.provider, "save_number");
  if (!gate.ok) return { kind: "skipped", reason: gate.reason ?? "gate" };

  const result = await renderAndSend({
    sql: args.sql,
    submission: args.submission,
    provider: args.provider,
    template: SAVE_NUMBER_BODY_TEMPLATE,
    commType: "call_reminder_save_number",
    tag: "save-number",
    triggerSource: "fastrack_qualify_pass",
  });
  return { kind: "sent", result };
}

// --- Trigger C: chaser on attempt_1_no_answer ---

export async function fireChaserSms(args: FireSmsArgs): Promise<SmsHelperOutcome> {
  const gate = await runSharedGates(args.sql, args.submission, args.provider, "chaser");
  if (!gate.ok) return { kind: "skipped", reason: gate.reason ?? "gate" };

  const result = await renderAndSend({
    sql: args.sql,
    submission: args.submission,
    provider: args.provider,
    template: CHASER_BODY_TEMPLATE,
    commType: "chaser_call_attempt",
    tag: "chaser-attempt-1",
    triggerSource: args.triggerSourceOverride ?? "attempt_1_no_answer",
    cooldownHours: args.cooldownHours,
  });
  return { kind: "sent", result };
}

// --- Trigger A: fastrack-link prompt (10 min post-routing, no fastrack yet) ---
// Gates are slightly different from B/C: uses the utility-enabled flag (same
// channel as save-number), and does NOT require a regional rep phone (the
// fastrack-link body cites only the provider company name + the form URL —
// no phone needed). Eligibility filtering on routing age + not-yet-fastracked
// happens in the caller (cron EF) to keep the per-row pass narrow.

export async function fireFastrackLinkSms(args: FireSmsArgs): Promise<SmsHelperOutcome> {
  // Subset of shared gates: funding gov/loan + phone + matched provider + opt-out flag.
  // No regional-rep-phone gate (this body doesn't reference phone).
  if (args.submission.funding_category !== "gov" && args.submission.funding_category !== "loan") {
    return { kind: "skipped", reason: `funding_category=${args.submission.funding_category ?? "null"} not in (gov, loan)` };
  }
  if (!args.submission.phone || args.submission.phone.trim().length === 0) {
    return { kind: "skipped", reason: "submission has no phone" };
  }
  if (!args.submission.primary_routed_to || args.submission.primary_routed_to !== args.provider.provider_id) {
    return { kind: "skipped", reason: "submission not matched to provided provider" };
  }

  const flagRows = await args.sql<Array<{ sms_utility_enabled: boolean }>>`
    SELECT sms_utility_enabled
      FROM crm.providers
     WHERE provider_id = ${args.provider.provider_id}
     LIMIT 1
  `;
  if (!flagRows[0]?.sms_utility_enabled) {
    return { kind: "skipped", reason: "provider has sms_utility_enabled=false" };
  }

  // Compose body. Uses {{PROVIDER_NAME}} (company) + {{FASTRACK_URL}} —
  // rep hasn't called yet so REP_FIRST_NAME would be premature.
  const matrix = await getMatrixContext(args.submission.course_id, args.submission.preferred_intake_id);
  const courseName = matrix.courseTitle ?? "your course";
  const fastrackUrl = buildFastrackUrlForSms(args.submission);
  if (!fastrackUrl) {
    return { kind: "skipped", reason: "no client_nonce — cannot build fastrack URL" };
  }

  const body = FASTRACK_LINK_BODY_TEMPLATE
    .replace("{{FIRSTNAME}}", args.submission.first_name ?? "there")
    .replace("{{COURSE_NAME}}", courseName)
    .replace("{{PROVIDER_NAME}}", args.provider.company_name)
    .replace("{{FASTRACK_URL}}", fastrackUrl);

  const recipientPhone = normaliseUkPhoneToE164(args.submission.phone);

  const result = await sendSms({
    sql: args.sql,
    submissionId: args.submission.id,
    commType: "call_reminder_fastrack_link",
    recipientPhone,
    body,
    metadata: {
      provider_id: args.provider.provider_id,
      trigger_source: "cron_10min_post_routing",
      la: args.submission.la,
      course_id: args.submission.course_id,
    },
    tag: "fastrack-link",
  });
  return { kind: "sent", result };
}

// Inline fastrack URL composer for the SMS body. Mirrors the existing
// buildFastrackUrl in route-lead.ts (kept private there to avoid two-callers
// drift, copied here intentionally — when Mable ships /f/{token}, this is the
// only call-site to update; route-lead.ts buildFastrackUrl keeps emitting the
// long URL for Brevo SW_FASTRACK_URL because email contexts have unlimited
// URL room).
function buildFastrackUrlForSms(submission: SubmissionRow): string {
  if (!submission.client_nonce) return "";
  const params = [`ref=${encodeURIComponent(submission.client_nonce)}`];
  if (submission.course_id) params.push(`course=${encodeURIComponent(submission.course_id)}`);
  params.push(`m=${submission.marketing_opt_in ? "1" : "0"}`);
  return `https://switchable.org.uk/funded/thank-you/?${params.join("&")}`;
}

// --- shared internals ---

async function runSharedGates(
  sql: Sql,
  submission: SubmissionRow,
  provider: ProviderRow,
  variant: "save_number" | "chaser",
): Promise<SmsGateResult> {
  // Funding gate: gov/loan only (matches spec — self-funded has no
  // callback pattern, no rep phone reliably set).
  if (submission.funding_category !== "gov" && submission.funding_category !== "loan") {
    return { ok: false, reason: `funding_category=${submission.funding_category ?? "null"} not in (gov, loan)` };
  }
  // Learner phone gate.
  if (!submission.phone || submission.phone.trim().length === 0) {
    return { ok: false, reason: "submission has no phone" };
  }
  // Matched provider gate.
  if (!submission.primary_routed_to || submission.primary_routed_to !== provider.provider_id) {
    return { ok: false, reason: "submission not matched to provided provider" };
  }
  // Provider opt-out gate.
  const flagRows = await sql<Array<{ sms_utility_enabled: boolean; sms_chaser_enabled: boolean }>>`
    SELECT sms_utility_enabled, sms_chaser_enabled
      FROM crm.providers
     WHERE provider_id = ${provider.provider_id}
     LIMIT 1
  `;
  const flags = flagRows[0];
  if (!flags) return { ok: false, reason: "provider not found at SMS flag lookup" };
  if (variant === "save_number" && !flags.sms_utility_enabled) {
    return { ok: false, reason: "provider has sms_utility_enabled=false" };
  }
  if (variant === "chaser" && !flags.sms_chaser_enabled) {
    return { ok: false, reason: "provider has sms_chaser_enabled=false" };
  }
  // Regional rep phone gate. Without a regional contact resolving to a
  // phone, the body's "Save their number / call you back on ..." can't
  // render meaningfully. We don't fall back to a generic provider company
  // phone — spec is explicit that non-regional providers don't get SMS.
  const contact = renderProviderContactValues(provider, submission);
  if (!contact.phone) return { ok: false, reason: "no regional rep phone for submission.la" };
  return { ok: true };
}

interface RenderAndSendArgs {
  sql: Sql;
  submission: SubmissionRow;
  provider: ProviderRow;
  template: string;
  commType: SmsLogType;
  tag: string;
  triggerSource: string;
  cooldownHours?: number;
}

async function renderAndSend(args: RenderAndSendArgs): Promise<SendSmsResult> {
  const matrix = await getMatrixContext(args.submission.course_id, args.submission.preferred_intake_id);
  const courseName = matrix.courseTitle ?? "your course";
  const repFirstName = resolveRepFirstName(args.provider, args.submission);
  const contact = renderProviderContactValues(args.provider, args.submission);

  const body = args.template
    .replace("{{FIRSTNAME}}", args.submission.first_name ?? "there")
    .replace("{{REP_FIRST_NAME}}", repFirstName || args.provider.company_name)
    .replace("{{COURSE_NAME}}", courseName)
    .replace("{{PROVIDER_PHONE}}", contact.phone);

  const recipientPhone = normaliseUkPhoneToE164(args.submission.phone ?? "");

  return await sendSms({
    sql: args.sql,
    submissionId: args.submission.id,
    commType: args.commType,
    recipientPhone,
    body,
    metadata: {
      provider_id: args.provider.provider_id,
      trigger_source: args.triggerSource,
      la: args.submission.la,
      course_id: args.submission.course_id,
    },
    tag: args.tag,
    cooldownHours: args.cooldownHours,
  });
}

// UK-centric. Pilot volume is all-UK; revisit if any non-UK lead lands
// (no current path for that — form geofences UK). Strategy:
//   - Strip spaces, hyphens, parentheses.
//   - "+44..." stays as-is.
//   - "0044..." → "+44..."
//   - "44XXXXXXXXXX" (12 digits, no leading +) → "+44..."
//   - "07XXX XXX XXX" (11 digits) → "+447..."
//   - "7XXX XXX XXX" (bare 10 digits, leading 0 stripped by Netlify numeric
//     coercion — see memory: feedback_netlify_forms_numeric_coercion.md) →
//     "+447..."
//   - Anything else returns as-is (sendSms will surface Brevo's reject if
//     the format's wrong — better than silent failure).
export function normaliseUkPhoneToE164(raw: string): string {
  const trimmed = raw.replace(/[\s\-()]/g, "");
  if (trimmed.startsWith("+")) return trimmed;
  if (trimmed.startsWith("0044")) return "+" + trimmed.slice(2);
  if (trimmed.startsWith("44") && trimmed.length === 12) return "+" + trimmed;
  if (trimmed.startsWith("07") && trimmed.length === 11) return "+44" + trimmed.slice(1);
  if (trimmed.startsWith("7") && trimmed.length === 10) return "+44" + trimmed;
  return trimmed;
}
