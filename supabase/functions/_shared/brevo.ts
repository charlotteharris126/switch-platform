// Shared Brevo helper.
//
// Used by:
//   - netlify-lead-router  — sends the rich owner notification email with confirm links (SwitchLeads brand)
//   - routing-confirm      — sends provider notification ("new enquiry, check sheet"),
//                             owner fallback ("sheet append failed, paste manually"),
//                             AND upserts the learner as a Brevo contact + adds to lists
//                             so Brevo Automations can run the Switchable utility + marketing
//                             sequences (Switchable brand, learner-facing).
//
// Secrets expected in env:
//   BREVO_API_KEY                  — transactional + contacts API key from Brevo dashboard
//   BREVO_SENDER_EMAIL             — SwitchLeads verified sender (e.g. charlotte@switchleads.co.uk)
//   BREVO_SENDER_EMAIL_SWITCHABLE  — Switchable verified sender (e.g. hello@switchable.org.uk)
//   BREVO_LIST_ID_SWITCHABLE_UTILITY  — list ID for Switchable utility stream (contract basis)
//   BREVO_LIST_ID_SWITCHABLE_MARKETING  — list ID for the consolidated Switchable marketing list (consent basis)
//
// On error, the caller is responsible for logging to leads.dead_letter.
// This helper surfaces the failure plainly and does not retry.
//
// On Brevo Automations triggers: this helper deliberately does not implement
// a generic "fire event" path. Brevo Automations can be triggered cleanly by
// attribute updates on a contact (e.g. SW_MATCH_STATUS=matched), which is what
// upsertBrevoContact does. Using attribute-driven triggers keeps the integration
// inside the standard Contacts API (BREVO_API_KEY, api.brevo.com/v3) and avoids
// the separate Marketing Automation Track endpoint which needs its own ma-key
// and tracker ID. If a future automation genuinely needs an event-stream model
// rather than an attribute model, add fireBrevoEvent then — not before.
//
// Attribute namespacing convention (decided 2026-04-29):
//   - FIRSTNAME / LASTNAME stay as unprefixed Brevo defaults.
//   - Switchable-brand attributes prefix with SW_ (e.g. SW_COURSE_NAME).
//   - SwitchLeads-brand attributes prefix with SL_ (e.g. SL_PILOT_STATUS).
// One email = one Brevo contact across both brands; namespacing prevents
// brand-specific fields colliding on shared records.

import type { Sql } from "npm:postgres@3";

const BREVO_TRANSACTIONAL_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
const BREVO_TRANSACTIONAL_SMS_ENDPOINT = "https://api.brevo.com/v3/transactionalSMS/sms";
const BREVO_CONTACTS_ENDPOINT = "https://api.brevo.com/v3/contacts";

// SMS sender ID for the Switchable utility channel. Alphanumeric, registered
// with Brevo's UK aggregator and verified LIVE 2026-05-21 16:35 UK (test send
// landed Accepted → Sent → Delivered). Sender is brand-locked: switchleads has
// no SMS channel today. Override via env if a future migration needs it.
const SMS_SENDER_ENV = "BREVO_SMS_SENDER_SWITCHABLE";
const SMS_SENDER_DEFAULT = "Switchable";

function resolveSmsSender(): string {
  return Deno.env.get(SMS_SENDER_ENV) ?? SMS_SENDER_DEFAULT;
}

// Defensive hard cap on any single Brevo call. Prior behaviour (no timeout) made
// a slow Brevo response block the caller for the full Edge Function 25s budget.
// In netlify-lead-router that meant Netlify's webhook timed out and, after 6
// consecutive failures, Netlify auto-disabled the whole webhook. We now accept
// that a rare slow Brevo call costs one missed email (recoverable) rather than
// risking the webhook (not recoverable). See changelog 2026-04-21 Session 3.3.
// 15s. Was 5s; bumped 2026-05-11 after a concurrent backfill at Brevo's
// 10 req/s rate limit starved a route-lead.ts upsert (dead-letter row,
// lead #370). Brevo can take >5s under load even for normal contact
// upserts; 15s gives headroom without making user-facing failures wait
// forever.
const BREVO_TIMEOUT_MS = 15000;

export type BrevoBrand = "switchleads" | "switchleads_leads" | "switchable";

interface BrandConfig {
  senderEmailEnv: string;
  senderName: string;
}

const BRANDS: Record<BrevoBrand, BrandConfig> = {
  // Portal-infra emails to providers (invite, password setup). Sends
  // from BREVO_SENDER_EMAIL — set to support@switchleads.co.uk.
  switchleads: { senderEmailEnv: "BREVO_SENDER_EMAIL", senderName: "SwitchLeads" },
  // Lead-notification emails to providers (U2 'new lead', presumed
  // warnings, presumed flipped). Sends from BREVO_SENDER_EMAIL_LEADS —
  // set to hello@switchleads.co.uk so the friendly inbox handles
  // operational lead notifications and support@ stays for account /
  // portal admin only.
  switchleads_leads: { senderEmailEnv: "BREVO_SENDER_EMAIL_LEADS", senderName: "SwitchLeads" },
  // Anything to a person who filled in a form on switchable.org.uk
  // (B2C learner OR B2B employer). Sends from
  // BREVO_SENDER_EMAIL_SWITCHABLE.
  switchable:  { senderEmailEnv: "BREVO_SENDER_EMAIL_SWITCHABLE", senderName: "Switchable" },
};

// Resolve a brand's sender email. Reads the brand-specific env var
// first. If it's empty AND the brand isn't the canonical SwitchLeads
// sender (BREVO_SENDER_EMAIL), fall back to BREVO_SENDER_EMAIL so
// brand-specific senders default to the SwitchLeads sender rather
// than failing. Lets us ship the switchleads_leads brand split
// without requiring the LEADS env var to be set first — until it is,
// lead notifications keep coming from support@ instead of breaking.
function resolveBrandSender(envName: string): string | undefined {
  const direct = Deno.env.get(envName);
  if (direct) return direct;
  if (envName === "BREVO_SENDER_EMAIL") return undefined;
  return Deno.env.get("BREVO_SENDER_EMAIL");
}

// Email types where appendOwnerCc applies. Everything else is sent to
// an external party (learner-facing utility, employer-facing S4B,
// marketing), and CCing the owner there leaks her address into a
// recipient inbox. The owner gets explicit visibility on new-lead +
// callback emails via buildCcList in route-lead.ts and
// admin-notify-callback, so those don't rely on this list either.
const OWNER_CC_ELIGIBLE_TYPES: ReadonlySet<EmailLogType> = new Set([
  "provider_presumed_warning",
  "provider_presumed_flipped",
]);

// Optional global cc. When OWNER_CC_ALL_EMAILS env var is set, every
// email sent via sendBrevoEmail or sendTransactional gets the owner
// cc'd. Comma-separated list supported. Used during launch monitoring
// so Charlotte sees what every Edge Function actually sends. Unset
// the env var to turn it off.
function appendOwnerCc(
  existing: Array<{ email: string; name?: string }> | undefined,
): Array<{ email: string; name?: string }> | undefined {
  const raw = Deno.env.get("OWNER_CC_ALL_EMAILS");
  if (!raw) return existing;
  const adds = raw.split(",").map((s) => s.trim()).filter(Boolean).map((email) => ({ email }));
  if (adds.length === 0) return existing;
  const seen = new Set((existing ?? []).map((c) => c.email.toLowerCase()));
  const merged = [...(existing ?? [])];
  for (const a of adds) {
    if (!seen.has(a.email.toLowerCase())) {
      merged.push(a);
      seen.add(a.email.toLowerCase());
    }
  }
  return merged.length > 0 ? merged : undefined;
}

export interface BrevoEmail {
  to: Array<{ email: string; name?: string }>;
  cc?: Array<{ email: string; name?: string }>;
  bcc?: Array<{ email: string; name?: string }>;
  subject: string;
  htmlContent: string;
  textContent?: string;
  replyTo?: { email: string; name?: string };
  tags?: string[];
  /** Sender selection. Defaults to "switchleads" for backward compatibility. */
  brand?: BrevoBrand;
}

export interface BrevoResult {
  ok: boolean;
  messageId?: string;
  status?: number;
  error?: string;
}

export async function sendBrevoEmail(email: BrevoEmail): Promise<BrevoResult> {
  const apiKey = Deno.env.get("BREVO_API_KEY");
  if (!apiKey) return { ok: false, error: "BREVO_API_KEY not set" };

  const brand = email.brand ?? "switchleads";
  const cfg = BRANDS[brand];
  const senderEmail = resolveBrandSender(cfg.senderEmailEnv);
  if (!senderEmail) return { ok: false, error: `${cfg.senderEmailEnv} not set` };

  const ccList = appendOwnerCc(email.cc);

  const body = {
    sender: { email: senderEmail, name: cfg.senderName },
    to: email.to,
    cc: ccList,
    bcc: email.bcc,
    subject: email.subject,
    htmlContent: email.htmlContent,
    textContent: email.textContent ?? stripHtml(email.htmlContent),
    replyTo: email.replyTo,
    tags: email.tags,
  };

  const res = await fetchBrevo(BREVO_TRANSACTIONAL_ENDPOINT, "POST", apiKey, body);
  if (!res.ok) return res;

  try {
    const data = await res.response!.json() as { messageId?: string };
    return { ok: true, messageId: data.messageId, status: res.status };
  } catch {
    return { ok: true, status: res.status };
  }
}

// =============================================================================
// Contacts API
// =============================================================================

/**
 * Brevo contact attributes. Keys are uppercased Brevo attribute names
 * (FIRSTNAME, COURSE_NAME, etc.). Values are coerced by Brevo to the type
 * configured for the attribute in the dashboard (text, number, date, boolean,
 * category). Pass strings unless the attribute is genuinely numeric/boolean.
 */
export type BrevoAttributes = Record<string, string | number | boolean | null>;

export interface UpsertContactArgs {
  email: string;
  attributes?: BrevoAttributes;
  /** Optional list IDs to add the contact to in the same call. */
  listIds?: number[];
  /**
   * Phase 3b channel-state push (spec: email-platform-rearchitecture-spec.md).
   * When boolean, sets `emailBlacklisted` on the Brevo contact in the same
   * request that updates attributes/listIds — keeps the Email campaigns
   * channel subscription state in lockstep with our DB's `marketing_opt_in`.
   *   true  → emailBlacklisted: false (subscribed, can receive marketing)
   *   false → emailBlacklisted: true  (unsubscribed from marketing channel)
   *   null/undefined → field omitted, Brevo leaves channel state untouched
   * Transactional sends are unaffected — Brevo gates those via a separate
   * `smtpBlacklistSender`/transac-blocked mechanism.
   */
  marketingOptIn?: boolean | null;
}

/**
 * Upsert a contact by email. Creates if missing, updates attributes if present.
 * Brevo's `updateEnabled: true` makes the POST idempotent on email.
 *
 * Returns ok: true on 201 (created) or 204 (updated). Returns the raw error
 * body on failure for the caller to log into leads.dead_letter.
 */
export async function upsertBrevoContact(args: UpsertContactArgs): Promise<BrevoResult> {
  const apiKey = Deno.env.get("BREVO_API_KEY");
  if (!apiKey) return { ok: false, error: "BREVO_API_KEY not set" };
  if (!args.email) return { ok: false, error: "email required" };

  const body: Record<string, unknown> = {
    email: args.email,
    updateEnabled: true,
  };
  if (args.attributes) body.attributes = args.attributes;
  if (args.listIds && args.listIds.length > 0) body.listIds = args.listIds;
  if (typeof args.marketingOptIn === "boolean") {
    body.emailBlacklisted = !args.marketingOptIn;
  }

  return await fetchBrevo(BREVO_CONTACTS_ENDPOINT, "POST", apiKey, body);
}

/**
 * Add an existing contact to an additional Brevo list. Use when the contact
 * already exists (e.g. flipping a learner from utility-only to marketing-included
 * after they later opt in).
 *
 * For first-time contact creation, prefer upsertBrevoContact with listIds
 * passed in the same call — it's one API hit instead of two.
 */
export async function addBrevoContactToList(args: { email: string; listId: number }): Promise<BrevoResult> {
  const apiKey = Deno.env.get("BREVO_API_KEY");
  if (!apiKey) return { ok: false, error: "BREVO_API_KEY not set" };
  if (!args.email) return { ok: false, error: "email required" };
  if (!args.listId) return { ok: false, error: "listId required" };

  const url = `${BREVO_CONTACTS_ENDPOINT}/lists/${args.listId}/contacts/add`;
  return await fetchBrevo(url, "POST", apiKey, { emails: [args.email] });
}

// Hard-deletes a contact from Brevo. Used by the GDPR right-to-erasure
// flow (gdpr-erase-learner Edge Function). Returns ok=true on 204 or 404
// (404 = already gone; idempotent). The Brevo API accepts an email OR
// identifier in the URL — we use the email.
export async function deleteBrevoContact(args: { email: string }): Promise<BrevoResult> {
  const apiKey = Deno.env.get("BREVO_API_KEY");
  if (!apiKey) return { ok: false, error: "BREVO_API_KEY not set" };
  if (!args.email) return { ok: false, error: "email required" };

  const url = `${BREVO_CONTACTS_ENDPOINT}/${encodeURIComponent(args.email)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BREVO_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        "api-key": apiKey,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    // 204 No Content = deleted. 404 Not Found = already gone (idempotent OK).
    if (res.status === 204 || res.status === 404) {
      return { ok: true };
    }
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      // ignore
    }
    return {
      ok: false,
      error: `Brevo DELETE contact HTTP ${res.status}: ${bodyText.slice(0, 500)}`,
    };
  } catch (err) {
    return { ok: false, error: describeFetchError(err) };
  } finally {
    clearTimeout(timeout);
  }
}

// =============================================================================
// Transactional templated send (Phase 2 of email rearchitecture, 2026-05-05)
// =============================================================================
// sendTransactional is the canonical helper for utility emails (U1, stalled,
// chaser, U4) under the spec at platform/docs/email-platform-rearchitecture-spec.md.
// It dedupes one-shot sends via crm.email_log, retries 429 / 5xx / transient
// network errors with exponential backoff, persists a leads.dead_letter row on
// final failure, and tags the row metadata with { shadow: true } when
// BREVO_SHADOW_MODE is on so the parallel-run period can be filtered out of
// post-cutover analytics.
//
// The chaser is the only email type that uses forceResend — every chaser send
// is a deliberate re-fire by the owner or by a sheet edit. All other email
// types are one-shot per submission_id.

const BREVO_TRANSACTIONAL_RETRY_DELAYS_MS = [250, 1000, 4000] as const;

export type EmailLogType =
  | "u1_funded" | "u1_self" | "u1_private"
  | "stalled_funded" | "stalled_self"
  | "chaser_funded" | "chaser_self"
  | "u4_funded" | "u4_self"
  | "n1" | "n2" | "n3"
  | "referral_cold" | "referral_lost"
  | "newsletter"
  | "provider_presumed_warning"
  // Post-flip notification to provider after auto-flip cron pushes a
  // lead to presumed_enrolled / presumed_employer_signed. Constraint
  // added in migration 0130.
  | "provider_presumed_flipped"
  | "re_engagement"
  // Switchable for Business v1 (employer apprenticeship leads, Riverside).
  // Constraint added in migration 0125. Chaser added in migration 0148.
  | "s4b_employer_u1"
  | "s4b_employer_ud"
  | "s4b_employer_chaser"
  // Fastrack qualifying ack — fires from fastrack-receive when the learner
  // submits the fastrack form AND clears the qualifying conditions
  // (cohort_confirmed === true AND l3_reconfirmed === false). Operational
  // confirmation of a successful application step plus named-rep callback
  // heads-up. Legal basis: contract. Constraint added in migration 0146.
  | "u_fastrack_qualified";

export interface SendTransactionalArgs {
  sql: Sql;
  templateId: number;
  recipient: { email: string; name?: string };
  params: Record<string, string | number | boolean | null>;
  submissionId: number;
  emailType: EmailLogType;
  /** Sender selection. Defaults to "switchable" — every utility email under the
   *  rearchitecture is learner-facing. */
  brand?: BrevoBrand;
  tags?: string[];
  replyTo?: { email: string; name?: string };
  /** Only the chaser path sets this. Relaxes the once-ever email_log
   *  idempotency check. On its own (resendWindowMinutes unset) it bypasses the
   *  check entirely — kept for any caller that genuinely wants an
   *  unconditional re-fire. The chaser pairs it with resendWindowMinutes so
   *  rapid duplicates still collapse. */
  forceResend?: boolean;
  /** Windowed dedup for the chaser path, mirroring sendSms.cooldownHours.
   *  When set, a send is skipped if a non-failed row for the same
   *  (submission_id, email_type) landed inside this many minutes. Combined
   *  with the per-(submission, type) advisory lock taken in the same
   *  transaction as the queued-row insert, this collapses near-simultaneous
   *  duplicate sends (double-clicked batch / overlapping fire / pg_net retry)
   *  while still allowing a deliberate re-chase once the window passes.
   *  Undefined keeps the legacy behaviour (once-ever when forceResend is
   *  false, unconditional when it is true). */
  resendWindowMinutes?: number;
}

export type SendTransactionalStatus =
  | "sent"
  | "failed"
  | "skipped_duplicate"
  | "skipped_missing_template";

export interface SendTransactionalResult {
  ok: boolean;
  status: SendTransactionalStatus;
  emailLogId?: number;
  brevoMessageId?: string;
  error?: string;
  shadowMode: boolean;
}

export async function sendTransactional(args: SendTransactionalArgs): Promise<SendTransactionalResult> {
  const shadowMode = (Deno.env.get("BREVO_SHADOW_MODE") ?? "true").toLowerCase() !== "false";

  if (!args.templateId) {
    return { ok: false, status: "skipped_missing_template", error: "templateId not set", shadowMode };
  }
  if (!args.recipient?.email) {
    return { ok: false, status: "failed", error: "recipient.email required", shadowMode };
  }

  // Idempotency + duplicate-send race guard.
  //
  // The dedup check and the queued-row insert run in ONE transaction holding a
  // per-(submission_id, email_type) advisory lock. Without the lock (the old
  // shape) two near-simultaneous fires for the same lead both passed the check
  // before either inserted, so both sent — that is how learners got 2-4
  // identical chasers within seconds. The xact lock serialises concurrent
  // fires; the second one blocks, then sees the first's queued row and skips.
  //
  // Dedup window:
  //   - resendWindowMinutes set (chaser): skip if a non-failed row landed
  //     inside the window. Collapses rapid duplicates, still allows a
  //     deliberate re-chase once the window passes.
  //   - forceResend true, no window: legacy unconditional re-fire (no check).
  //   - neither (default transactional): once-ever — skip if any non-failed
  //     row exists.
  //
  // 'failed' rows never block — a previous failure must not silence the next
  // attempt.
  const windowMins = typeof args.resendWindowMinutes === "number" && args.resendWindowMinutes > 0
    ? args.resendWindowMinutes
    : null;
  let emailLogId: number;
  try {
    const outcome = await args.sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      // Serialise concurrent sends for the same (submission_id, email_type).
      // hashtext returns int4; pg_advisory_xact_lock(bigint) accepts it.
      await trx`SELECT pg_advisory_xact_lock(hashtext(${`${args.submissionId}:${args.emailType}`}))`;

      if (windowMins !== null) {
        const recent = await trx<Array<{ id: number }>>`
          SELECT id FROM crm.email_log
           WHERE submission_id = ${args.submissionId}
             AND email_type    = ${args.emailType}
             AND status IN ('queued','sent','delivered','opened','clicked')
             AND triggered_at  > now() - make_interval(mins => ${windowMins})
           LIMIT 1
        `;
        if (recent.length > 0) return { dup: true as const, id: Number(recent[0].id) };
      } else if (!args.forceResend) {
        const existing = await trx<Array<{ id: number }>>`
          SELECT id FROM crm.email_log
           WHERE submission_id = ${args.submissionId}
             AND email_type    = ${args.emailType}
             AND status IN ('queued','sent','delivered','opened','clicked')
           LIMIT 1
        `;
        if (existing.length > 0) return { dup: true as const, id: Number(existing[0].id) };
      }

      // Insert the queued row up front so post-mortem traces show the attempt
      // even if the Brevo call hangs the function or the host process dies
      // mid-send. Inside the lock so the row is visible to the next fire the
      // instant this transaction commits.
      const rows = await trx<Array<{ id: number }>>`
        INSERT INTO crm.email_log (
          submission_id, email_type, channel, template_id, recipient_email,
          status, metadata
        ) VALUES (
          ${args.submissionId},
          ${args.emailType},
          'transactional',
          ${String(args.templateId)},
          ${args.recipient.email},
          'queued',
          ${trx.json({
            shadow: shadowMode,
            shadow_log_only: shadowMode,
            force_resend: !!args.forceResend,
          })}
        )
        RETURNING id
      `;
      return { dup: false as const, id: Number(rows[0].id) };
    });

    if (outcome.dup) {
      return { ok: true, status: "skipped_duplicate", emailLogId: outcome.id, shadowMode };
    }
    emailLogId = outcome.id;
  } catch (err) {
    console.error("sendTransactional email_log guard/insert failed:", String(err));
    return { ok: false, status: "failed", error: `email_log insert: ${describeFetchError(err)}`, shadowMode };
  }

  // Phase 2 shadow window: skip the actual Brevo call so learners only
  // receive the legacy automation email, not a duplicate from the new
  // path. The email_log row is still flipped to status='sent' so parity
  // dashboards register the would-have-been send. metadata.shadow_log_only
  // is set on insert so post-cutover analytics can filter these out.
  // brevo_message_id stays NULL — that's the unambiguous signal that the
  // row didn't actually leave Brevo's transactional API.
  if (shadowMode) {
    try {
      await args.sql.begin(async (trx) => {
        await trx`SET LOCAL ROLE functions_writer`;
        await trx`
          UPDATE crm.email_log
             SET status = 'sent',
                 sent_at = now()
           WHERE id = ${emailLogId}
        `;
      });
    } catch (err) {
      console.error("sendTransactional shadow log-only update failed:", String(err));
    }
    return { ok: true, status: "sent", emailLogId, shadowMode };
  }

  const brand = args.brand ?? "switchable";
  const cfg = BRANDS[brand];
  const senderEmail = resolveBrandSender(cfg.senderEmailEnv);
  const apiKey = Deno.env.get("BREVO_API_KEY");

  if (!apiKey || !senderEmail) {
    const reason = !apiKey ? "BREVO_API_KEY not set" : `${cfg.senderEmailEnv} not set`;
    await markEmailLogFailed(args.sql, emailLogId, reason);
    await persistTransactionalDeadLetter(args.sql, args, emailLogId, reason);
    return { ok: false, status: "failed", error: reason, emailLogId, shadowMode };
  }

  const ccList = OWNER_CC_ELIGIBLE_TYPES.has(args.emailType)
    ? appendOwnerCc(undefined)
    : undefined;
  const body = {
    sender: { email: senderEmail, name: cfg.senderName },
    to: [args.recipient],
    cc: ccList,
    templateId: Number(args.templateId),
    params: args.params,
    replyTo: args.replyTo,
    tags: args.tags,
  };

  const sendResult = await callTransactionalWithRetry(apiKey, body);
  if (!sendResult.ok) {
    const errMsg = sendResult.error ?? `brevo ${sendResult.status ?? "?"}`;
    await markEmailLogFailed(args.sql, emailLogId, errMsg);
    await persistTransactionalDeadLetter(args.sql, args, emailLogId, errMsg);
    return { ok: false, status: "failed", error: errMsg, emailLogId, shadowMode };
  }

  let messageId: string | undefined;
  try {
    const data = await sendResult.response!.json() as { messageId?: string };
    messageId = data.messageId;
  } catch {
    // Brevo returned 2xx with no parseable body. Send happened; just no id.
  }

  try {
    await args.sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        UPDATE crm.email_log
           SET status = 'sent',
               sent_at = now(),
               brevo_message_id = ${messageId ?? null}
         WHERE id = ${emailLogId}
      `;
    });
  } catch (err) {
    console.error("sendTransactional email_log update failed (sent path):", String(err));
    // Send already happened. Don't surface as failure; the row is just stale.
  }

  return { ok: true, status: "sent", emailLogId, brevoMessageId: messageId, shadowMode };
}

async function callTransactionalWithRetry(apiKey: string, body: unknown): Promise<InternalResult> {
  let lastResult: InternalResult = { ok: false };
  const maxAttempts = BREVO_TRANSACTIONAL_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = BREVO_TRANSACTIONAL_RETRY_DELAYS_MS[attempt - 1];
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    lastResult = await fetchBrevo(BREVO_TRANSACTIONAL_ENDPOINT, "POST", apiKey, body);
    if (lastResult.ok) return lastResult;
    const status = lastResult.status ?? 0;
    // Treat status-undefined (network error / timeout) as retryable.
    const isRetryable = !status || status === 429 || (status >= 500 && status < 600);
    if (!isRetryable) return lastResult;
  }
  return lastResult;
}

async function markEmailLogFailed(sql: Sql, emailLogId: number, errorText: string): Promise<void> {
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        UPDATE crm.email_log
           SET status     = 'failed',
               error_text = ${errorText.slice(0, 4000)}
         WHERE id = ${emailLogId}
      `;
    });
  } catch (err) {
    console.error("markEmailLogFailed failed:", String(err));
  }
}

async function persistTransactionalDeadLetter(
  sql: Sql,
  args: SendTransactionalArgs,
  emailLogId: number,
  errorContext: string,
): Promise<void> {
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        INSERT INTO leads.dead_letter (source, raw_payload, error_context)
        VALUES (
          'brevo_transactional',
          ${trx.json({
            submission_id: args.submissionId,
            email_type: args.emailType,
            template_id: args.templateId,
            recipient_email: args.recipient.email,
            email_log_id: emailLogId,
          })},
          ${errorContext.slice(0, 4000)}
        )
      `;
    });
  } catch (err) {
    console.error("persistTransactionalDeadLetter failed:", String(err));
  }
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) return err.message ?? String(err);
  return String(err);
}

// =============================================================================
// Internal
// =============================================================================

interface InternalResult extends BrevoResult {
  /** Raw Response object — kept on success so the caller can inspect the body. */
  response?: Response;
}

async function fetchBrevo(
  url: string,
  method: string,
  apiKey: string,
  body: unknown,
): Promise<InternalResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BREVO_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
        "accept": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      return { ok: false, error: `brevo timeout after ${BREVO_TIMEOUT_MS}ms` };
    }
    return { ok: false, error: `fetch failed: ${String(err)}` };
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "<body unreadable>");
    return { ok: false, status: res.status, error: `brevo ${res.status}: ${text.slice(0, 500)}` };
  }

  return { ok: true, status: res.status, response: res };
}

function stripHtml(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n")
             .replace(/<\/p>/gi, "\n\n")
             .replace(/<[^>]+>/g, "")
             .replace(/&nbsp;/g, " ")
             .replace(/&amp;/g, "&")
             .replace(/&lt;/g, "<")
             .replace(/&gt;/g, ">")
             .replace(/\n{3,}/g, "\n\n")
             .trim();
}

// =============================================================================
// Transactional SMS send (Chunk 1 of SMS utility, 2026-05-21)
// =============================================================================
// sendSms is the canonical helper for utility SMS under the spec at
// switchable/email/docs/sms-utility-design.md (Wren, locked 2026-05-21).
// Three comm types: call_reminder_fastrack_link, call_reminder_save_number,
// chaser_call_attempt. Default dedup is once-ever per (submission_id,
// comm_type) — the auto-fire path (attempt_1_no_answer trigger) relies on
// this. The bulk admin chaser path passes cooldownHours=24 to window the
// dedup check, letting Charlotte re-push a learner the next day. The
// partial unique index sms_log_submission_type_uniq was dropped in
// migration 0176 because it couldn't express the time-windowed semantic;
// dedup is now purely application-side via the SELECT below.
//
// Bodies are template-literal in the calling code (NOT Brevo-templated). The
// rendered string is passed in and stored in crm.sms_log.body_rendered for
// post-hoc visibility. This is intentional per the spec ("less surface area
// to keep in sync, one fewer env var per variant").
//
// Shadow mode mirrors the email helper: BREVO_SMS_SHADOW_MODE=true (default)
// inserts the sms_log row with status='sent' but does NOT actually call the
// Brevo SMS API. Flip to "false" via env to go live.

const BREVO_SMS_RETRY_DELAYS_MS = [250, 1000, 4000] as const;

export type SmsLogType =
  | "call_reminder_fastrack_link"
  | "call_reminder_save_number"
  | "chaser_call_attempt";

export interface SendSmsArgs {
  sql: Sql;
  /** E.164-formatted phone (e.g. "+447123456789"). The helper does NOT validate
   *  — caller is responsible for normalisation. */
  recipientPhone: string;
  /** Rendered SMS body. Merge fields must already be resolved. */
  body: string;
  submissionId: number;
  commType: SmsLogType;
  /** Free-form metadata recorded on the sms_log row. Provider_id, trigger
   *  source, etc. Not for PII. */
  metadata?: Record<string, unknown>;
  /** Brevo "tag" field — surfaces in their dashboard for filtering. */
  tag?: string;
  /** Optional dedup window. When set, the (submission_id, comm_type)
   *  idempotency check only blocks if a non-failed row landed within this
   *  many hours. When undefined (default), the check is once-ever (matches
   *  the auto-fire path: provider clicks attempt_1_no_answer → one SMS). The
   *  manual batch path (crm.fire_sms_chaser_bulk → sms-chaser-attempt-1)
   *  passes 24 so Charlotte can re-push a learner tomorrow if needed. */
  cooldownHours?: number;
}

export type SendSmsStatus =
  | "sent"
  | "failed"
  | "skipped_duplicate"
  | "skipped_missing_phone";

export interface SendSmsResult {
  ok: boolean;
  status: SendSmsStatus;
  smsLogId?: number;
  brevoMessageId?: string;
  error?: string;
  shadowMode: boolean;
}

export async function sendSms(args: SendSmsArgs): Promise<SendSmsResult> {
  const shadowMode = (Deno.env.get("BREVO_SMS_SHADOW_MODE") ?? "true").toLowerCase() !== "false";

  if (!args.recipientPhone) {
    return { ok: false, status: "skipped_missing_phone", error: "recipientPhone required", shadowMode };
  }
  if (!args.body || args.body.trim().length === 0) {
    return { ok: false, status: "failed", error: "body required", shadowMode };
  }

  // Idempotency + duplicate-send race guard. Same shape as sendTransactional:
  // the dedup check and the queued-row insert run in ONE transaction holding a
  // per-(submission_id, comm_type) advisory lock, so two near-simultaneous
  // fires for the same lead can't both pass the check before either inserts.
  //
  //   - cooldownHours undefined: once-ever — the auto-fire attempt-1 path
  //     relies on this so a learner only ever gets one auto SMS.
  //   - cooldownHours set (manual batch, 24h): windowed — re-push allowed the
  //     next day, rapid duplicates inside the window collapsed.
  //
  // 'failed' / 'undelivered' rows never block — a previous failure must not
  // silence the next attempt.
  const cooldownHours = typeof args.cooldownHours === "number" && args.cooldownHours > 0
    ? args.cooldownHours
    : null;
  let smsLogId: number;
  try {
    const outcome = await args.sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      // Serialise concurrent sends for the same (submission_id, comm_type).
      await trx`SELECT pg_advisory_xact_lock(hashtext(${`${args.submissionId}:${args.commType}`}))`;

      const existing = cooldownHours === null
        ? await trx<Array<{ id: number }>>`
            SELECT id FROM crm.sms_log
             WHERE submission_id = ${args.submissionId}
               AND comm_type     = ${args.commType}
               AND status IN ('queued','sent','delivered')
             LIMIT 1
          `
        : await trx<Array<{ id: number }>>`
            SELECT id FROM crm.sms_log
             WHERE submission_id = ${args.submissionId}
               AND comm_type     = ${args.commType}
               AND status IN ('queued','sent','delivered')
               AND triggered_at  > now() - make_interval(hours => ${cooldownHours})
             LIMIT 1
          `;
      if (existing.length > 0) return { dup: true as const, id: Number(existing[0].id) };

      // Insert the queued row up front so post-mortem traces show the attempt
      // even if the Brevo call hangs the function. Inside the lock so it's
      // visible to the next fire the instant this transaction commits.
      const rows = await trx<Array<{ id: number }>>`
        INSERT INTO crm.sms_log (
          submission_id, comm_type, recipient_phone, status, body_rendered, metadata
        ) VALUES (
          ${args.submissionId},
          ${args.commType},
          ${args.recipientPhone},
          'queued',
          ${args.body},
          ${trx.json({
            shadow: shadowMode,
            shadow_log_only: shadowMode,
            ...(args.metadata ?? {}),
          })}
        )
        RETURNING id
      `;
      return { dup: false as const, id: Number(rows[0].id) };
    });

    if (outcome.dup) {
      return { ok: true, status: "skipped_duplicate", smsLogId: outcome.id, shadowMode };
    }
    smsLogId = outcome.id;
  } catch (err) {
    console.error("sendSms sms_log guard/insert failed:", String(err));
    return { ok: false, status: "failed", error: `sms_log insert: ${describeFetchError(err)}`, shadowMode };
  }

  // Shadow mode: skip the actual Brevo call but flip the row to sent so the
  // log shows what would have happened. brevo_message_id stays NULL — that's
  // the unambiguous signal that the row didn't actually leave the API.
  if (shadowMode) {
    try {
      await args.sql.begin(async (trx) => {
        await trx`SET LOCAL ROLE functions_writer`;
        await trx`
          UPDATE crm.sms_log
             SET status = 'sent',
                 sent_at = now()
           WHERE id = ${smsLogId}
        `;
      });
    } catch (err) {
      console.error("sendSms shadow log-only update failed:", String(err));
    }
    return { ok: true, status: "sent", smsLogId, shadowMode };
  }

  const apiKey = Deno.env.get("BREVO_API_KEY");
  if (!apiKey) {
    const reason = "BREVO_API_KEY not set";
    await markSmsLogFailed(args.sql, smsLogId, reason);
    await persistSmsDeadLetter(args.sql, args, smsLogId, reason);
    return { ok: false, status: "failed", error: reason, smsLogId, shadowMode };
  }

  const sender = resolveSmsSender();
  const body = {
    sender,
    recipient: args.recipientPhone,
    content: args.body,
    type: "transactional",
    tag: args.tag,
  };

  const sendResult = await callSmsWithRetry(apiKey, body);
  if (!sendResult.ok) {
    const errMsg = sendResult.error ?? `brevo sms ${sendResult.status ?? "?"}`;
    await markSmsLogFailed(args.sql, smsLogId, errMsg);
    await persistSmsDeadLetter(args.sql, args, smsLogId, errMsg);
    return { ok: false, status: "failed", error: errMsg, smsLogId, shadowMode };
  }

  let messageId: string | undefined;
  try {
    const data = await sendResult.response!.json() as { messageId?: string | number };
    messageId = data.messageId != null ? String(data.messageId) : undefined;
  } catch {
    // 2xx with no parseable body. Send happened; just no id.
  }

  try {
    await args.sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        UPDATE crm.sms_log
           SET status = 'sent',
               sent_at = now(),
               brevo_message_id = ${messageId ?? null}
         WHERE id = ${smsLogId}
      `;
    });
  } catch (err) {
    console.error("sendSms sms_log update failed (sent path):", String(err));
    // Send already happened; row is just stale, don't surface as failure.
  }

  return { ok: true, status: "sent", smsLogId, brevoMessageId: messageId, shadowMode };
}

async function callSmsWithRetry(apiKey: string, body: unknown): Promise<InternalResult> {
  let lastResult: InternalResult = { ok: false };
  const maxAttempts = BREVO_SMS_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = BREVO_SMS_RETRY_DELAYS_MS[attempt - 1];
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    lastResult = await fetchBrevo(BREVO_TRANSACTIONAL_SMS_ENDPOINT, "POST", apiKey, body);
    if (lastResult.ok) return lastResult;
    const status = lastResult.status ?? 0;
    const isRetryable = !status || status === 429 || (status >= 500 && status < 600);
    if (!isRetryable) return lastResult;
  }
  return lastResult;
}

async function markSmsLogFailed(sql: Sql, smsLogId: number, errorText: string): Promise<void> {
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        UPDATE crm.sms_log
           SET status     = 'failed',
               error_text = ${errorText.slice(0, 4000)}
         WHERE id = ${smsLogId}
      `;
    });
  } catch (err) {
    console.error("markSmsLogFailed failed:", String(err));
  }
}

async function persistSmsDeadLetter(
  sql: Sql,
  args: SendSmsArgs,
  smsLogId: number,
  errorContext: string,
): Promise<void> {
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        INSERT INTO leads.dead_letter (source, raw_payload, error_context)
        VALUES (
          'brevo_transactional_sms',
          ${trx.json({
            submission_id: args.submissionId,
            comm_type: args.commType,
            recipient_phone: args.recipientPhone,
            sms_log_id: smsLogId,
          })},
          ${errorContext.slice(0, 4000)}
        )
      `;
    });
  } catch (err) {
    console.error("persistSmsDeadLetter failed:", String(err));
  }
}
