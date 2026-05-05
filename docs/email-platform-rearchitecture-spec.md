# Email Platform Rearchitecture — Build Spec

**Date:** 2026-05-05
**Status:** Spec, awaiting Sasha's review and start
**Owner sign-off required before phase 1 starts**

## Purpose

The current email setup runs both utility (contract-basis) and marketing (consent-basis) emails through Brevo's automation engine. This causes two problems:

1. **Compliance / operational:** when a contact unsubscribes from a marketing automation, Brevo blocks them from ALL automation emails — including the utility emails they should still receive on contract basis. The Email campaigns channel and the Transactional channel are separate at Brevo's contact-record level; we need to put each email type on the correct channel.

2. **Platform robustness:** automation-driven utility sends have no audit log, no idempotency guarantees, no retry/dead-letter handling, no bounce/complaint flow, and no programmatic visibility from our admin dashboard.

This spec describes the proper architecture, the migration plan to get there, and the work split.

## Current state vs target state

| Aspect | Current | Target |
|---|---|---|
| Utility emails (U1, stalled, chaser, U4) | Brevo automation workflows triggered by list-add | Brevo Transactional API called from Edge Functions |
| Marketing emails (N1-N3, referrals, future newsletter) | Not built yet | Brevo automation/campaign workflows on Email campaigns channel |
| Consent enforcement | List filtering only (single point of failure) | List filtering + channel subscription (belt-and-braces) |
| Audit log | None for utility sends | `crm.email_log` table records every send |
| Bounce/complaint handling | None | Brevo webhook → Edge Function → `crm.email_log` + suppress |
| Dead letter | Already in place for routing | Extends to email sends |
| Visibility | Brevo automation UI only | Admin dashboard shows per-lead email status + automations page |

## Architecture overview

**Source of truth:** Supabase. The DB owns consent state, lead state, enrolment status, send history. Brevo is the delivery mechanism and template store.

**Channels (per Brevo contact record):**
- **Transactional** — utility emails. Always subscribed for active contacts. Only unsubscribed if the contact hard-bounces or explicitly opts out of transactional (rare, hard to do).
- **Email campaigns** — marketing emails. Subscribed if `SW_CONSENT_MARKETING = true` and not bounced. Unsubscribed via the standard `{{ unsubscribe }}` link in marketing emails.

**Email types and their triggers:**

| Email | Channel | Trigger | Idempotency |
|---|---|---|---|
| U1 welcome (funded + self) | Transactional | Edge Function calls Brevo Transactional API on routing-confirm success | One-shot per submission |
| Stalled day-4 | Transactional | Daily pg_cron queries open leads at day 4, sends via API | One-shot per submission |
| Chaser (SF2) | Transactional | Manual dashboard click OR sheet `cannot_contact` status change | Always-allow re-send (timestamp-tracked) |
| U4 enrolment | Transactional | DB trigger or scheduled job on `SW_ENROL_STATUS` change to enrolled/presumed_enrolled | One-shot per submission |
| Marketing N1-N3 | Email campaigns | Brevo automation, entry filter `SW_CONSENT_MARKETING = true` AND on marketing list | Brevo native |
| Referral cold-lead | Email campaigns | Brevo automation, entry filter `SW_CONSENT_MARKETING = true` AND created 28+ days AND not enrolled | Brevo native |
| Referral lost-lead | Email campaigns | Brevo automation, entry filter `SW_CONSENT_MARKETING = true` AND status in (cannot_contact, lost) | Brevo native |
| Newsletter (future) | Email campaigns | Brevo manual campaign, segment = consenting + not enrolled | n/a |

## Build phases

The migration runs in 6 phases. Phases 1-3 must be completed before any marketing automation goes live (phase 5). Phases are designed to be reversible — each one is a discrete unit with its own rollback.

---

### Phase 1 — DB foundations and Brevo webhook receiver

**Goal:** Add the audit table, the bounce/complaint receiver, and the email-status columns on the admin dashboard. No live email behaviour changes yet.

#### Sasha tasks
- [ ] Migration `00XX_email_log_table.sql` — create `crm.email_log` with columns:
  - `id` BIGSERIAL PRIMARY KEY
  - `submission_id` BIGINT NOT NULL REFERENCES `leads.submissions(id)`
  - `email_type` TEXT NOT NULL CHECK in (`u1_funded`, `u1_self`, `stalled_funded`, `stalled_self`, `chaser`, `u4_funded`, `u4_self`, `n1`, `n2`, `n3`, `referral_cold`, `referral_lost`, `newsletter`, ...)
  - `channel` TEXT NOT NULL CHECK in (`transactional`, `email_campaigns`)
  - `template_id` TEXT NOT NULL
  - `recipient_email` TEXT NOT NULL
  - `triggered_at` TIMESTAMPTZ NOT NULL DEFAULT now()
  - `sent_at` TIMESTAMPTZ
  - `status` TEXT NOT NULL CHECK in (`queued`, `sent`, `failed`, `bounced_hard`, `bounced_soft`, `complained`, `delivered`, `opened`, `clicked`)
  - `brevo_message_id` TEXT
  - `error_text` TEXT
  - `metadata` JSONB
  - Index on `(submission_id, email_type)` and `(status, triggered_at)`
  - RLS: full access to `functions_writer`, read-only to `readonly_analytics`
- [ ] Migration `00XX_consent_history_table.sql` — create `crm.consent_history` with:
  - `id`, `submission_id`, `field_changed` (e.g. `SW_CONSENT_MARKETING`), `old_value`, `new_value`, `changed_at`, `changed_by` (user/system/contact-action), `source` (form/unsubscribe/admin/api)
  - Used as audit trail for consent changes
- [ ] Migration `00XX_erasure_and_access_log.sql` — create two GDPR audit tables (deferred from compliance section, now in scope for Phase 1):
  - `crm.erasure_log`: `id`, `submission_id` (nullable, since contact may exist outside our submissions), `requester_email`, `requested_at`, `completed_at`, `request_source` (form/email/api), `what_was_anonymised` JSONB (per-table summary), `processed_by`, `notes`. RLS: admin-read only.
  - `crm.access_log`: `id`, `submission_id` (nullable), `requester_email`, `requested_at`, `completed_at`, `request_source`, `export_format`, `processed_by`, `notes`. RLS: admin-read only.
  - Both tables `functions_writer` insert + admin read. No PII in the audit row itself beyond requester_email.
- [ ] New Edge Function `brevo-event-webhook`:
  - Receives Brevo webhook events (delivered, opened, clicked, hard_bounce, soft_bounce, spam, unsubscribed, etc.)
  - Updates `crm.email_log.status` based on event
  - For hard_bounce, soft_bounce: log + flag for suppression
  - For spam complaint: auto-unsubscribe from Email campaigns channel, log to `crm.consent_history`
  - For unsubscribe: log to `crm.consent_history`, update `SW_CONSENT_MARKETING = false` in Supabase, sync to Brevo
  - **Auth: HMAC signature verification on every request** using Brevo's webhook signing (shared secret stored in Supabase Vault as `BREVO_WEBHOOK_SECRET`). Reject any request whose signature header doesn't match. Header-based, never URL query string. Reference: Brevo docs on webhook signature verification.
  - Deploy with `--no-verify-jwt` (auth handled by HMAC, not JWT)
- [ ] Configure the Brevo webhook in Brevo dashboard pointing to `brevo-event-webhook` URL, with the matching shared secret configured for signing
- [ ] Update `infrastructure-manifest.md` with new function, new tables (email_log, consent_history, erasure_log, access_log), new secret (BREVO_WEBHOOK_SECRET)
- [ ] Update `data-architecture.md` with all four new tables

#### Charlotte tasks
- [ ] Finish DKIM/SPF/DMARC setup for `switchable.org.uk` with Brevo (in progress as of 2026-05-05). Phase 1 Edge Function work can ship before this completes, but the success criteria below is gated on green DNS records.
- [ ] Decide owner-test domain handling — recommend: send utility emails to test domains as normal (lets us test end-to-end) but flag in Brevo with subject prefix `[TEST]` controlled by an env flag

#### Success criteria
- All four migration tables exist (email_log, consent_history, erasure_log, access_log)
- Webhook URL configured in Brevo, signed test event arrives at Edge Function (HMAC verified) and lands in `crm.email_log`
- Unsigned/wrong-signature test request is rejected with 401
- DKIM/SPF/DMARC all green for switchable.org.uk

#### Rollback
- Disable webhook URL in Brevo
- Drop migration tables (DOWN section)

---

### Phase 2 — Utility emails to transactional, in shadow mode

**Goal:** Send U1, stalled, chaser, U4 via Transactional API alongside the existing automations. Compare outputs. Disable automations only after parity verified.

#### Sasha tasks
- [ ] Set up new transactional templates in Brevo (or duplicate existing automation templates as transactional — they need to be in the Transactional template section, not Campaign)
  - Template IDs stored as env vars: `BREVO_TEMPLATE_U1_FUNDED`, `BREVO_TEMPLATE_U1_SELF`, `BREVO_TEMPLATE_STALLED_FUNDED`, `BREVO_TEMPLATE_STALLED_SELF`, `BREVO_TEMPLATE_CHASER`, `BREVO_TEMPLATE_U4_FUNDED`, `BREVO_TEMPLATE_U4_SELF`
- [ ] Add `BREVO_SHADOW_MODE` env flag to relevant Edge Functions (default `true` initially)
- [ ] Update `_shared/brevo.ts`:
  - New function `sendTransactional(templateId, recipient, params, submissionId, emailType, opts?: { forceResend?: boolean })`:
    - Pre-send validation: required params present, recipient email valid
    - Idempotency check (skipped if `opts.forceResend = true`): query `crm.email_log` for `(submission_id, email_type)` where `status` in `(sent, queued, delivered, opened, clicked)`. If exists, return early (skip duplicate). The chaser is the only email_type currently expected to use `forceResend` — every chaser send is a deliberate re-send by the owner or by a sheet edit.
    - Insert `crm.email_log` row with status `queued` (every send, including forced re-sends, gets a new row)
    - Call Brevo Transactional API
    - On success: update row to `sent` + store `brevo_message_id`
    - On 429 or 5xx: retry with exponential backoff (250ms, 1s, 4s)
    - On final failure: update row to `failed` + log to `leads.dead_letter` with `source = 'brevo_transactional'`
    - If `BREVO_SHADOW_MODE = true`, log the call but mark the row `metadata: { shadow: true }` to indicate parallel-run
- [ ] Update `routing-confirm/index.ts`:
  - On success, call `sendTransactional(BREVO_TEMPLATE_U1_FUNDED or U1_SELF, ...)` based on funding category
  - In shadow mode: still adds to utility list (existing behaviour) AND sends transactional. Log both.
  - Verify: same recipient gets both emails initially, then we cut over
- [ ] New Edge Function `email-stalled-cron`:
  - Triggered by daily pg_cron at 09:00 UTC
  - **Stalled email framing:** the email asks "have you heard from your provider yet?" — it's checking on the provider's response, not chasing the learner. Subject line and body copy must use that framing (NOT "we haven't heard from you").
  - Query: `SELECT s.id FROM leads.submissions s WHERE s.created_at < now() - interval '4 days' AND s.is_dq = false AND s.archived_at IS NULL AND s.id NOT IN (SELECT submission_id FROM crm.enrolments WHERE status IN ('enrolled', 'presumed_enrolled')) AND s.id NOT IN (SELECT submission_id FROM crm.email_log WHERE email_type LIKE 'stalled_%' AND status IN ('sent', 'delivered', 'opened', 'clicked'))`
  - For each, call `sendTransactional` with the right stalled template per funding (no `forceResend` — one-shot)
  - Idempotency from `crm.email_log` query
- [ ] Update `admin-brevo-chase` Edge Function:
  - Replace list-add call with `sendTransactional(BREVO_TEMPLATE_CHASER, ..., { forceResend: true })` per contact. `forceResend` is required because the chaser is the only email type the owner can fire repeatedly.
  - Continue updating `crm.enrolments.last_chaser_at` timestamp atomically alongside the email_log write (Phase 2 keeps the column dual-written; Phase 4 retires it — see "last_chaser_at source of truth" note below)
  - Preserve dead-letter on failure
  - In shadow mode: still adds to list (old behaviour) AND sends transactional
- [ ] New Edge Function `email-u4-cron` (scheduled, not a DB trigger):
  - Triggered by daily pg_cron at 09:30 UTC (matches today's existing U4 automation cadence in Brevo)
  - Decision: scheduled job over DB trigger. A synchronous DB trigger calling Brevo would block the writer of `crm.enrolments` if Brevo is slow; scheduled job is safer and ~24h max latency on U4 send is acceptable.
  - Query: `SELECT e.submission_id FROM crm.enrolments e JOIN leads.submissions s ON s.id = e.submission_id WHERE e.status IN ('enrolled', 'presumed_enrolled') AND s.is_dq = false AND s.archived_at IS NULL AND e.submission_id NOT IN (SELECT submission_id FROM crm.email_log WHERE email_type LIKE 'u4_%' AND status IN ('sent', 'delivered', 'opened', 'clicked'))`
  - For each, call `sendTransactional` with U4 template (funded or self based on funding category) — no `forceResend` (one-shot)
  - In shadow mode: still adds to enrolled list (old behaviour) AND sends transactional
- [ ] Update Apps Script `provider-sheet-edit-mirror.gs` to point at the new Edge Function flow rather than list-add (only after the new flow is verified)
- [ ] Add `cron job` rows to `infrastructure-manifest.md` for `email-stalled-cron-daily` (09:00 UTC) and `email-u4-cron-daily` (09:30 UTC)

#### last_chaser_at source of truth (Phase 2 → Phase 4 cutover)

`crm.enrolments.last_chaser_at` exists today and is read by the admin dashboard's "last chaser" column. After Phase 2, `crm.email_log` also records every chaser send. To avoid a dual-source-of-truth drift risk:

- **Phase 2 (interim):** the chaser send path writes BOTH `crm.email_log` AND `crm.enrolments.last_chaser_at` in a single transaction. Both stay in sync because there's only one writer (`admin-brevo-chase`). Dashboard continues reading `last_chaser_at`.
- **Phase 4 (cutover):** `email_log` becomes the sole source of truth. Either (a) drop the column and replace the dashboard query with `SELECT MAX(triggered_at) FROM crm.email_log WHERE email_type = 'chaser' AND submission_id = ...`, or (b) replace the column with a `GENERATED ALWAYS AS` column derived from email_log. Choice deferred until Phase 4 — depends on whether email_log query performance is acceptable for the dashboard list view.

This is the only existing column with this dual-write risk. Future email-status fields (e.g. `last_u4_sent_at`) should NOT be added to `crm.enrolments` — read them from `email_log` directly via a view.

#### Charlotte tasks
- [ ] Confirm transactional templates are in Brevo's Transactional section with correct IDs
- [ ] Test by submitting a test form, verify both emails arrive (during shadow mode)
- [ ] After parity verified for ≥48 hours, signal Sasha to cut over (set `BREVO_SHADOW_MODE = false`)
- [ ] After cutover holds for ≥48 hours, disable old utility automations in Brevo (don't delete — just turn off, keep for rollback)

#### Success criteria
- All utility emails (U1 funded/self, stalled funded/self, chaser, U4 funded/self) send via transactional API
- `crm.email_log` records every send. Idempotency holds for one-shot emails (U1, stalled, U4). Chaser permits re-sends via `forceResend: true` and writes a fresh row each time.
- Stalled cron skips DQ and archived rows (verified by smoke test: submit owner-test form, confirm no stalled email arrives at day 4)
- U4 cron skips DQ and archived rows
- Test send shows correct variables rendered, correct from/reply-to, correct unsubscribe behaviour (no unsubscribe in utility transactional emails)
- Failed sends land in `leads.dead_letter` with retry attempted
- `crm.enrolments.last_chaser_at` stays in sync with `crm.email_log` chaser rows (dual-write verified for ≥48h before Phase 3 starts)

#### Rollback
- Set `BREVO_SHADOW_MODE = true` again (parallel run resumes)
- Re-enable old Brevo utility automations

---

### Phase 3 — Channel subscription enforcement and backfill

**Goal:** Lock down marketing consent at channel level. Existing non-consenting contacts get their Email campaigns channel unsubscribed.

#### Sasha tasks
- [ ] Update `_shared/brevo.ts`:
  - On contact create/update, if `SW_CONSENT_MARKETING = false`, call Brevo API to unsubscribe contact from Email campaigns channel
  - If `SW_CONSENT_MARKETING = true`, call Brevo API to ensure subscribed to Email campaigns channel
  - Atomic: if either the attribute or the channel update fails, log to dead_letter and retry
  - Log all consent state changes to `crm.consent_history`
- [ ] One-off backfill script `data-ops/00XX_backfill_email_campaigns_channel.ts`:
  - Query: all contacts in Brevo with corresponding submission in Supabase
  - **Process in batches of 100 contacts at a time, with a 250ms delay between API calls** (matches the existing pattern in `admin-brevo-resync`). Don't fire the entire backfill at once — small batches keep us under Brevo's rate limit and let us catch errors before they cascade.
  - **Halt on error rate >0.5% within a batch** (rather than continuing blindly). Surfaces problems early instead of corrupting thousands of records before noticing. Owner reviews failed contacts manually before resuming.
  - Resumable: write a checkpoint after each batch (last contact_id processed) to `data-ops/.backfill-checkpoint.json` (gitignored) so a halted run can pick up rather than restart from scratch.
  - For each: read `SW_CONSENT_MARKETING` from contact attributes, sync Email campaigns channel state to match
  - Log every change to `crm.consent_history` with `source = 'backfill'`
  - Output: counts of changes made, contacts skipped, errors per batch + cumulative
- [ ] New Edge Function `brevo-consent-reconcile-daily`:
  - Daily cron at 04:00 UTC
  - Pulls Brevo channel state, compares to Supabase `SW_CONSENT_MARKETING`
  - Flags drift (e.g. someone unsubscribed via Brevo's UI but our DB doesn't know)
  - Auto-corrects by updating Supabase to match Brevo (Brevo is the source of truth for unsubscribe events because the contact actioned it there)
  - Logs to `crm.consent_history`
  - Emails Charlotte if drift > X% of contacts (probable bug)
- [ ] Add cron row to manifest

#### Charlotte tasks
- [ ] Verify Brevo's marketing list (or whichever segment will be used for marketing automations) accurately reflects consenting + non-enrolled contacts after backfill runs
- [ ] Spot-check 5-10 random contacts: their Email campaigns channel state should match their `SW_CONSENT_MARKETING` value

#### Success criteria
- All non-consenting contacts have Email campaigns channel = unsubscribed
- All consenting contacts have Email campaigns channel = subscribed
- Future contact creation/updates flow through the new logic
- Daily reconciliation finds <0.1% drift in steady state

#### Rollback
- Pause the daily reconciliation cron
- Backfill script doesn't need rollback (consent state is what we want it to be — if anything was wrong, fix forward)

---

### Phase 4 — Retire old utility automations

**Goal:** Old Brevo utility automations are turned off and archived. Single source of truth for utility sends is the transactional API.

#### Charlotte tasks
- [ ] Verify `crm.email_log` shows utility sends flowing through transactional for ≥7 days
- [ ] Verify no dead_letter rows for `source = 'brevo_transactional'`
- [ ] Disable each utility automation in Brevo (Settings → status → Off, do not delete)
- [ ] Archive the old utility templates in Brevo's Campaign template section (move to an "Archived" folder), keep transactional templates active

#### Sasha tasks
- [ ] Cutover `crm.enrolments.last_chaser_at` to email_log-derived. Decide between (a) drop the column and read `MAX(triggered_at)` from `email_log` in the dashboard query, or (b) keep the column but back it with a `GENERATED ALWAYS AS` expression. Pick whichever performs acceptably on the leads list view (dashboard list query is the perf-sensitive consumer). Drop the dual-write code in `admin-brevo-chase` once cutover is done.
- [ ] Update `infrastructure-manifest.md` to reflect retired automations under "Retired infrastructure" section
- [ ] Update `switchable/email/CLAUDE.md` to describe new architecture (replace "list-add triggers automation" sections)
- [ ] Update `platform/docs/changelog.md` with full migration entry

#### Success criteria
- Old automations off, transactional flow is sole utility delivery mechanism
- Manifest reflects current reality

#### Rollback
- Re-enable old automations in Brevo
- Set `BREVO_SHADOW_MODE = true` to dual-run

---

### Phase 5 — Build marketing automations

**Goal:** N1-N3 funded nurture, referral cold-lead, referral lost-lead live in Brevo with proper consent enforcement at entry.

#### Charlotte tasks
- [ ] Create N1, N2, N3, referral-cold-lead, referral-lost-lead templates in Brevo (Campaign type, marketing footer with `{{ unsubscribe }}`)
- [ ] Build N1-N3 automation:
  - Entry: contact added to marketing list (or attribute change to `SW_CONSENT_MARKETING = true` if no list-based trigger)
  - Entry condition: `SW_CONSENT_MARKETING = true` AND `SW_FUNDING_CATEGORY in (gov, loan)` AND `SW_MATCH_STATUS = matched`
  - Email campaigns channel must be subscribed (Brevo handles automatically)
  - Step delays: day 2 (N1), day 8 (N2), day 15 (N3)
  - Exit conditions: `SW_ENROL_STATUS in (enrolled, presumed_enrolled)` OR `SW_COURSE_INTAKE_DATE < now()` OR `SW_CONSENT_MARKETING = false`
- [ ] Build referral cold-lead automation:
  - Entry: daily filter — contacts created 28+ days ago AND `SW_ENROL_STATUS not in (enrolled, presumed_enrolled)` AND `SW_CONSENT_MARKETING = true`
  - Re-entry: disabled
- [ ] Build referral lost-lead automation:
  - Entry: contacts where `SW_ENROL_STATUS in (cannot_contact, lost)` AND `SW_CONSENT_MARKETING = true`
  - Wait 5 days, then send referral lost-lead email
  - Re-entry: disabled
- [ ] Test each automation: send a test contact through, verify entry, exit, and unsubscribe behaviour

#### Sasha tasks
- [ ] Verify Edge Function correctly sets contact's marketing list membership based on `SW_CONSENT_MARKETING` value (if list-based entry trigger is chosen)
- [ ] Add cron job `marketing-automation-eligibility-sync-daily` if needed to keep marketing list in sync with consent + enrolment state

#### Success criteria
- All five marketing automations live
- Test contacts entering and exiting correctly
- Unsubscribe in any marketing email flips Email campaigns channel and updates Supabase via the webhook receiver from phase 1

#### Rollback
- Pause each automation
- Marketing list flushed if needed (no permanent damage; contacts can re-enter when re-launched)

---

### Phase 6 — Admin dashboard visibility

**Goal:** Charlotte sees email status from the admin dashboard, not just from Brevo's UI.

#### Sasha tasks
- [ ] Per-lead detail view: show email log entries (type, sent_at, status, last event) chronologically
- [ ] Leads table: add columns or icons summarising send status (e.g. "U1 ✓, Stalled ✓, U4 —, Chaser 2d ago")
- [ ] New `/admin/automations` page:
  - Lists each utility automation with: trigger, last run, recent send count (24h, 7d), failure count, latest failures
  - Lists each marketing automation (data pulled from Brevo if API allows, otherwise just a link to Brevo)
  - Per-automation drill-down: recent sends, status breakdown
- [ ] Failure alert email: if any utility send fails for >3 consecutive attempts, email Charlotte

#### Charlotte tasks
- [ ] Confirm dashboard surfaces what she actually wants to see day-to-day (iterate)

#### Success criteria
- Charlotte can answer "did this lead get U1?" without leaving the admin dashboard
- Visible alerting when something is broken

#### Rollback
- Hide the new pages/columns. Underlying data remains.

---

## Compliance considerations

### GDPR

- **Right to erasure (Article 17):** new SOP — when a deletion request comes in:
  1. Sasha runs script: delete contact from Brevo via API, anonymise/delete `leads.submissions`, `crm.enrolments`, `crm.email_log` rows (cascade with anonymisation, not full delete, to preserve aggregate stats with email/PII redacted)
  2. Log the erasure event in a new `crm.erasure_log` table with timestamp, request source, what was deleted/anonymised
  3. Confirm to requester within 30 days per GDPR

- **Right of access (Article 15):** new SOP — Sasha runs export script that pulls all data on a contact across submissions, enrolments, email_log, consent_history, partials, dead_letter. Returns as JSON. Log to `crm.access_log`.

- **Consent withdrawal:** automatically logged via `crm.consent_history`. Audit trail shows when, where, how.

- **Sub-processor disclosure:** Brevo is a sub-processor (data processor). Privacy policy currently uses generic "AI tools" wording (per memory `feedback_subprocessor_list_when_to_split.md`). Worth confirming Brevo specifically is mentioned or generally covered. No change needed for this migration unless gap identified.

- **DPA with Brevo:** Brevo provides a standard DPA in their terms. Confirm it's accepted in our Brevo account settings.

### Bounce / complaint handling

- Hard bounces: contact suppressed from future sends across all channels (set both Email campaigns and Transactional channels to unsubscribed)
- Soft bounces: log but don't suppress (transient). Repeated soft bounces (>5 in 30 days) escalate to hard suppression
- Spam complaints: auto-unsubscribe from Email campaigns channel, log, alert Charlotte for review (could indicate content problem)

### PECR (UK direct marketing rules)

- Marketing emails require consent (covered by `SW_CONSENT_MARKETING`)
- Soft opt-in could apply to some lifecycle marketing if there's a prior business relationship, but for safety we treat all marketing as consent-required
- Unsubscribe must be free, easy, and immediate — Brevo's `{{ unsubscribe }}` handles this

---

## Deliverability practices

Sender reputation is the silent layer that determines whether emails land in inbox vs spam. Building this into the architecture from day one is cheaper than fixing reputation damage later.

### Authentication (Phase 1)

- **DKIM, SPF, DMARC** verified for `switchable.org.uk` (Charlotte's task in Phase 1). switchleads.co.uk already verified.
- **DMARC policy** set to `p=quarantine` minimum (better: `p=reject` once confidence is high).
- **BIMI** (logo in inbox) — optional, defer until DMARC `p=reject` is in place.

### List hygiene (ongoing)

- **Hard bounces** — auto-suppress on Email campaigns channel + Transactional channel via `brevo-event-webhook`. Never re-send. (Phase 1)
- **Soft bounces** — log; if >5 soft bounces in 30 days for a contact, escalate to hard suppression.
- **Spam complaints** — auto-unsubscribe from Email campaigns channel + alert. (Phase 1)
- **Sunset policy (new)** — contacts who haven't opened any email in 180 days get one re-engagement email; if still no engagement after 14 days, suppress from marketing only (Email campaigns channel). Daily cron job. **Add to Sasha's Phase 5 scope.**
- **Engagement-based entry filter for marketing** — every marketing automation entry condition includes `last_open_at > now() - 90 days OR contact_age < 30 days` (don't punish brand-new contacts who haven't had time to engage). **Charlotte applies this when building automations in Phase 5.**

### Content practices (every template)

- **Plain-text alternative** required for every HTML email. Brevo can auto-generate; verify quality, override if it produces nonsense.
- **No spam trigger words** in subject lines or first paragraph: avoid "FREE", "GUARANTEE", "WIN", "ACT NOW", "LIMITED TIME", excessive `!!!`, ALL CAPS, $$$.
- **Brevo content quality score** — every template should be checked in Brevo's content checker before going live.
- **Sender consistency** — `hello@switchable.org.uk` for all Switchable; `hello@switchleads.co.uk` for all SwitchLeads. Never mix.
- **Reply-to is monitored** — both above are real inboxes. No `noreply@` addresses anywhere.
- **Avoid link shorteners** (bit.ly, tinyurl etc.) — they trigger spam filters and obscure URLs.
- **Reasonable text-to-image ratio** — avoid image-only emails, which spam filters down-rate. All templates must have meaningful text content.

### Volume and reputation

- **Volume ramping** for switchable.org.uk — when the newsletter or referral campaigns scale to thousands of sends, ramp gradually. Brevo handles a lot of this on shared IPs, but sudden 10x volume spikes can flag spam systems.
- **Brevo postmaster monitoring** — Brevo's deliverability dashboard surfaces sender reputation, open rates, click rates, bounce rate, complaint rate. **Add to Mira's Monday audit checklist.**
- **Dedicated IP** — Brevo Premium tier offers this. Worth it once monthly send volume exceeds ~50k. Defer.

### Tracking and UTMs

- **Brevo link tracking** wraps URLs in tracking redirects. By default it does NOT auto-append UTMs, but the wrapping itself can interfere with referral codes in URLs.
- **Per-template tracking decisions:** referral CTA emails should have link tracking OFF (to keep the referral URL clean). Nurture content links can have tracking ON to measure engagement.
- **UTM convention** for marketing emails: `utm_source=brevo`, `utm_medium=email`, `utm_campaign=<automation_name>`, `utm_content=<email_step>`. Set in the link itself, not via Brevo auto-append.

### Newsletter / blog scaling context

The blog launches soon and the monthly newsletter will be a high-volume marketing email. The architecture handles this natively (Email campaigns channel, marketing list filtering, channel-level unsubscribe), but a few additions:

- **Newsletter list architecture** — single consolidated marketing list works for now. If newsletter audience grows much larger than nurture audience (e.g. blog readers signing up directly without going through the form), we may need a separate "newsletter only" list. **Decision deferred until we see actual signup patterns post-blog launch.**
- **Newsletter sender** — same `hello@switchable.org.uk`, same authentication.
- **Newsletter cadence** — monthly; volume-spike consideration if we add ad-hoc broadcasts.
- **Blog-driven signups** — when the blog launches, the signup form must follow the same `SW_CONSENT_MARKETING` + channel subscription rules. Add to the platform scope when the blog signup form ships.

---

## Testing strategy

### End-to-end regression test (run after any change to email flow)

1. Submit a test form (use an owner-test domain, e.g. `+test@switchable.org.uk`)
2. Verify within 5 minutes: U1 email arrives, `crm.email_log` row exists with status `sent` or `delivered`
3. Manually trigger `email-stalled-cron` Edge Function
4. Verify within 1 minute: stalled email arrives (because lead is open + 4 days old in test data)
5. Open admin dashboard, click "Send chaser" for the test lead
6. Verify within 1 minute: chaser email arrives, `last_chaser_at` updated
7. Manually update `crm.enrolments.status` to `enrolled` in Supabase
8. Verify within 5 minutes: U4 email arrives
9. Submit another test form with `marketing_opt_in = true` and consent-driven entry through marketing automations
10. Verify N1 arrives at day 2 (or trigger early via test mode)
11. Click unsubscribe in N1 email
12. Verify Email campaigns channel flips to unsubscribed in Brevo, `SW_CONSENT_MARKETING` updates to false in Supabase via webhook
13. Verify subsequent transactional sends (e.g. U4 if status changes) still arrive — utility unaffected by marketing unsubscribe

### Owner-test domain handling

- Owner-test domains (`switchable.org.uk`, `switchable.careers`, `switchable.com`, `switchleads.co.uk`) currently auto-flag with `is_dq=true`
- For email migration: utility transactional sends should still fire for these (so we can test end-to-end). Add subject prefix `[TEST]` controlled by an env flag, default ON for `is_dq=true` records.

### Brevo testing

- Brevo doesn't have a sandbox. Test using owner-test domains.
- Test sends within Brevo's UI may not process `{{ unsubscribe }}` correctly. Use real ends sends to test owner addresses.

---

## Documentation updates required

When the build ships:

- `platform/docs/infrastructure-manifest.md` — new Edge Functions, new cron jobs, new tables, new secrets, retired automations
- `platform/docs/data-architecture.md` — `crm.email_log`, `crm.consent_history`, `crm.erasure_log`, `crm.access_log` (all four ship in Phase 1)
- `platform/docs/changelog.md` — full migration entry (migrations 00XX through 00YY)
- `switchable/email/CLAUDE.md` — replace the "list-add triggers automation" architecture description with transactional model
- `switchable/email/docs/current-handoff.md` — current state at end of migration
- `.claude/rules/data-infrastructure.md` — verify still consistent (probably no change)
- Notion privacy policy — confirm coverage is accurate (probably no change, generic wording)
- New SOP doc: `accounts-legal/gdpr-request-handling.md` — handling erasure and access requests
- New SOP doc: `platform/docs/email-platform-runbook.md` — common operations (send a transactional, debug a failed send, handle a complaint, etc.)

---

## Rollback plan summary

Each phase has its own rollback. Big-picture: if anything goes wrong at any phase, the previous architecture is still available because we don't delete anything until verified working. Old automations stay in Brevo (off, but present) for at least 30 days post-migration.

---

## Open questions — owner decisions locked 2026-05-05

1. **Owner-test domain in transactional:** ✅ Send with `[TEST]` subject prefix, controlled by env flag, default ON for `is_dq=true` records.
2. **Spam complaint alert threshold:** ✅ >0.1% complaint rate over 7 days triggers alert.
3. **Reconciliation drift threshold:** ✅ >2% drift between Brevo channel state and Supabase consent triggers daily alert.
4. **Rollback retention:** ✅ Old utility automations stay off-but-present in Brevo for 90 days post-cutover before deletion.
5. **Migration sequencing:** ✅ Phase 1 → 2a (U1 path + shadow mode infra) → 2b (stalled + chaser + U4) → 3 → 4 → 5/6 (parallel). Confirmed by Sasha 2026-05-05.
6. **Schema versioning for Brevo attributes:** Deferred until first real attribute change requires it.

## Spec amendments — 2026-05-05

After spec review, the following corrections were made before Phase 1 starts:

- **Stalled-email query (Phase 2):** added `is_dq = false` and `archived_at IS NULL` filters. Without these, owner-test and DQ leads would have received the stalled email.
- **Stalled-email framing (Phase 2):** copy is "have you heard from your provider yet?" — checking on the provider's response, not chasing the learner. Subject line and body must use that framing.
- **Chaser idempotency (Phase 2):** `sendTransactional` gains an optional `forceResend` param. The chaser is the only email type that uses it (every chaser send is a deliberate re-send).
- **Webhook auth (Phase 1):** `brevo-event-webhook` requires HMAC signature verification using Brevo's webhook signing, with `BREVO_WEBHOOK_SECRET` in Supabase Vault. Header-based, never URL query string. Reject unsigned/wrong-signature requests with 401.
- **`last_chaser_at` source of truth (Phase 2 → Phase 4):** explicit dual-write in Phase 2; cutover to email_log-derived in Phase 4. Future email-status fields are added to email_log, never to `crm.enrolments`.
- **GDPR audit tables (Phase 1):** `crm.erasure_log` and `crm.access_log` moved into Phase 1 scope (previously listed in compliance section but not phased — would have been forgotten).
- **U4 trigger (Phase 2):** scheduled job at 09:30 UTC daily, matching today's existing Brevo automation cadence. Not a DB trigger (sync DB triggers calling Brevo would block writers if Brevo is slow).
- **Phase 3 backfill:** batches of 100, 250ms inter-call delay, halt on >0.5% error rate per batch, checkpoint-resumable. Catches problems early instead of corrupting thousands of contacts.
- **DKIM/SPF/DMARC for switchable.org.uk:** in progress with Brevo as of 2026-05-05. Phase 1 Edge Function work can ship before this completes; the success criteria gates on DNS being green.

---

## Estimated scope (Sasha to refine)

- Phase 1: 1 platform session (small)
- Phase 2: 2 platform sessions (medium-large; new patterns being established)
- Phase 3: 1 platform session (medium)
- Phase 4: <1 session (mostly verification + docs)
- Phase 5: Charlotte-led, 1-2 sessions in Brevo
- Phase 6: 1 platform session (medium)

Total: ~5-6 Sasha sessions plus 1-2 Charlotte Brevo sessions, sequenced over 2-3 weeks.

---

## Sign-off

- Owner: ✅ 2026-05-05 — all open questions decided, deliverability section approved, blog/newsletter scaling context noted
- Sasha: ✅ 2026-05-05 — spec reviewed, 9 amendments accepted by owner same session (see "Spec amendments" above), phase sequencing locked.

Phase 1 ready to start in next platform session.
