# Platform Handoff, Session 31, 2026-05-05

## Current state

Phase 1 of the email platform rearchitecture is **commissioned end-to-end**. Three new tables live in production (`crm.email_log`, `crm.consent_history`, `audit.access_requests`). `brevo-event-webhook` Edge Function deployed, `BREVO_WEBHOOK_SECRET` set in Vault, Brevo dashboard webhook configured with matching bearer, real Brevo event verified hitting the function with 200 (counter on Brevo side: 1 successful delivery). No live behaviour change yet — Phase 1 is foundations only; writers come in Phase 2. Earlier in the same session, a wrong-path `is_test` column (migration 0070) was added then immediately reverted (0071) when the existing `dq_reason='owner_test_submission'` mechanism was rediscovered; two test leads were back-tagged correctly; a one-click test-tag toggle was added to the dashboard (migration 0072 + new server action).

## What was done this session

**Email rearchitecture, Phase 1:**
- Migration 0073 `crm.email_log`: per-send audit row, idempotency key, indexes on submission+type / status+time / brevo_message_id. RLS: admin + analytics read, functions_writer ALL.
- Migration 0074 `crm.consent_history`: append-only consent state log (no UPDATE/DELETE policy by design). Submission_id nullable for future newsletter-only contacts.
- Migration 0075 `audit.access_requests`: GDPR right-of-access log mirroring the existing `audit.erasure_requests` shape from migration 0016. Spec originally proposed parallel `crm.erasure_log`; on review of 0016 the spec was amended to reuse `audit.erasure_requests` rather than duplicate.
- New Edge Function `brevo-event-webhook` deployed (`--no-verify-jwt`, with bearer-token auth). Maps Brevo events → `crm.email_log.status` updates by `brevo_message_id`. For unsubscribe/spam events, also writes `crm.consent_history`. Phase 3 will add the round-trip to flip `SW_CONSENT_MARKETING` in Brevo + Supabase; Phase 1 only logs.
- Webhook auth: shared-secret bearer in `Authorization` header. Brevo's public docs do not document HMAC payload signing (verified 2026-05-05 against developers.brevo.com). Spec amendment 3 was corrected from "HMAC sig verification" to "shared-secret bearer in custom header" — Brevo's dashboard supports custom headers per webhook, which gives equivalent protection when the secret is high-entropy.
- `data-architecture.md` updated with all three new tables.
- `infrastructure-manifest.md` updated with new function row, new secret row (`BREVO_WEBHOOK_SECRET`), and refreshed owner-test allowlist.
- Spec also patched mid-session for the `audit.erasure_requests` reuse and the Brevo HMAC correction.

**Earlier this session (test-lead cleanup, separate concern):**
- Migration 0070 (`is_test` flag) shipped, then reverted by 0071 — net effect on schema zero.
- Two test leads back-tagged: #277 `hello@charlie-harris.com`, #284 `kieranwrites@gmail.com`. Owner cleared the EMS Google Sheet rows manually (both had been routed before back-tagging).
- Allowlist in `_shared/ingest.ts` extended: domain `charlie-harris.com`, email `kieranwrites@gmail.com`. `netlify-lead-router` + `netlify-leads-reconcile` redeployed.
- Migration 0072: column-level `GRANT UPDATE (is_dq, dq_reason, archived_at)` + `admin_update_owner_test_flags` RLS policy.
- Dashboard: `markOwnerTestSubmission` server action + `OwnerTestToggle` button on lead detail page.
- Migration history repairs: 0049, 0068, 0069 marked applied (schema was already in prod from prior SQL-editor applies — verified before repair).
- Session 30 handoff stale claims corrected (0049's columns exist in prod; route-lead.ts HubSpot edits are committed at `16cb56b`).

## Next steps

1. **Phase 2a (next platform session):** stand up `sendTransactional` helper in `_shared/brevo.ts` (with optional `forceResend` param, idempotency check on `crm.email_log`, retry + dead-letter), set up transactional templates in Brevo (`BREVO_TEMPLATE_U1_FUNDED` etc.), wire up `routing-confirm` to call it for U1, ship `BREVO_SHADOW_MODE` env flag (default true). Live U1 sends still go via the existing automation; the new path runs in parallel for parity verification.
2. **Phase 2b (one platform session after 2a):** `email-stalled-cron` (09:00 UTC daily), update `admin-brevo-chase` to use `forceResend: true`, `email-u4-cron` (09:30 UTC daily). Stalled cron query MUST include `is_dq = false AND archived_at IS NULL` per spec amendment.
3. Courses Direct: chase Ranjit for HubSpot form URL. Once received: assign `crm_webhook_url` + generate `crm_webhook_token` on `crm.providers.courses-direct`. No further code/schema work needed.
4. Update infrastructure manifest "Last verified" date for `iris-daily-flags` once it has its first scheduled run (08:30 UTC daily).

## Decisions and open questions

- `audit.erasure_requests` (live since migration 0016) is reused for GDPR Article 17 erasure tracking; new `audit.access_requests` mirrors it for Article 15 access. The original spec proposal of parallel `crm.erasure_log` + `crm.access_log` was retired in favour of reusing existing audit infrastructure.
- Brevo webhook auth uses shared-secret bearer in custom header rather than HMAC payload signing. Decided after verifying Brevo's docs don't document HMAC — the bearer pattern with a high-entropy secret gives equivalent protection. Spec amendment 3 corrected accordingly.
- Owner-test tagging belongs to the canonical DQ path, not a parallel `is_test` column. Decided this session after audit. One mechanism, one source of truth.

## Watch items

- **🔴 Shadow mode monitoring (Charlotte) — cutover target Thursday 2026-05-08.** Charlotte runs the U1-only parity query against `crm.email_log` once tonight and once tomorrow night. Thursday she pings Sasha "ready for cutover" — Sasha then runs a wider query covering U1 + stalled + chaser + U4 (since Phase 2 will have shipped by then and day-4 leads will be candidates), and flips `BREVO_SHADOW_MODE = false` + redeploys 5 functions if all green. 48h after cutover Charlotte pauses the old utility automations in Brevo. Why 48h not 24h: gives ~4-6 real Phase-2 leads through the parity window vs ~2-3, more cutover confidence. Query and full procedure in `switchable/email/docs/current-handoff.md`.
- First scheduled `iris-daily-flags` cron run (08:30 UTC daily) — verify it fires and produces flags.
- Courses Direct HubSpot integration remains dormant pending Ranjit's form URL.
- EMS Susan auto-flip billing trigger — first billable enrolment forecast imminent.
- `admin_update_owner_test_flags` RLS policy is the first UPDATE policy on `leads.submissions` for the `authenticated` role — watch for any unintended writes via other code paths.
- DKIM/SPF/DMARC for switchable.org.uk — Charlotte working on this with Brevo. Required before Phase 2a deliverability is trustworthy.
- Phase 1 commissioning lessons (worth carrying forward to any future webhook setup): Supabase secrets dashboard shows SHA-256 digest, NOT the secret value — set secrets via CLI; Brevo's Token-auth method auto-prepends `Bearer ` so paste only the hex into Brevo.

## Next session

- **Folder:** platform/
- **First task:** Phase 2a of email rearchitecture — stand up `sendTransactional` helper in `_shared/brevo.ts`, set up Brevo transactional templates for U1 (funded + self), wire up `routing-confirm` to call it, ship `BREVO_SHADOW_MODE` env flag. Spec at `platform/docs/email-platform-rearchitecture-spec.md`. Phase 1 already commissioned end-to-end so no setup gating Phase 2a.
- **Cross-project:** switchable/email session 12 produced the spec; Phase 1 (this session) and Phase 3 (channel enforcement + backfill) must ship before email returns to Phase 5 (build N1/N2/N3 + referral automations in Brevo). Charlotte's parallel task: finish DKIM/SPF/DMARC setup for switchable.org.uk in Brevo (in progress).
