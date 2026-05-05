# Platform Handoff, Session 31, 2026-05-05

## Current state

Platform healthy. Migration history clean (local and remote both at 0072). Two test leads (#277, #284) corrected to the canonical owner-test DQ shape. Dashboard now has a one-click toggle for tagging owner-test submissions, removing the SQL-editor round-trip Charlotte had to do twice today. Owner-test allowlist extended for `charlie-harris.com` and `kieranwrites@gmail.com` so future submissions from those addresses auto-DQ at ingest.

## What was done this session

- Migration 0070 (`is_test` flag) shipped, then immediately reverted by 0071 after audit showed the canonical owner-test path (`is_dq=true`, `dq_reason='owner_test_submission'`, `archived_at=now()`) already covers this case. Net effect on schema: zero.
- Two test leads back-tagged correctly: #277 `hello@charlie-harris.com`, #284 `kieranwrites@gmail.com`. Both now `is_dq=true`, `dq_reason='owner_test_submission'`, `archived_at` set. Both had already been routed to enterprise-made-simple via the sheet webhook before tagging — owner cleared the EMS Google Sheet rows manually.
- Owner-test allowlist in `_shared/ingest.ts` extended: domain `charlie-harris.com` added to `OWNER_TEST_DOMAINS`; email `kieranwrites@gmail.com` added to `OWNER_TEST_EMAILS`. `netlify-lead-router` and `netlify-leads-reconcile` redeployed.
- Migration 0072: column-level `GRANT UPDATE (is_dq, dq_reason, archived_at)` and `admin_update_owner_test_flags` RLS policy on `leads.submissions`. Mirrors the migration 0051 pattern.
- Dashboard: `markOwnerTestSubmission` server action and `OwnerTestToggle` client component added to the lead detail page header. "Mark as test lead" / "Remove test flag" with a confirm prompt on the mark action. Only shows "Remove" when `dq_reason='owner_test_submission'` so legitimate DQ rows (waitlist, no_match, etc.) are never touched.
- Migration history repairs: 0049, 0068, 0069 marked applied (their schema was already in prod from prior SQL-editor applies — verified column/index/policy presence directly before repair).
- Stale claims in session 30 handoff corrected: 0049's column/index do exist in prod; route-lead.ts HubSpot edits are committed (commit `16cb56b`). What is genuinely paused is provider-side enablement (no provider has `crm_webhook_url`/`crm_webhook_token` set) — not the code or schema.

## Next steps

1. **TOP PRIORITY (new): Phase 1 of email platform rearchitecture.** Spec at `platform/docs/email-platform-rearchitecture-spec.md` (owner-signed 2026-05-05; reviewed and amended by Sasha same session — see "Spec amendments" section). Phase 1 = four migrations (`crm.email_log`, `crm.consent_history`, `crm.erasure_log`, `crm.access_log`), new `brevo-event-webhook` Edge Function with HMAC signature verification, configure Brevo webhook to point at it. Decision-blocker resolved at email session 12 — switchable/email is waiting on platform to ship Phase 1 before any new marketing automations can launch. Phase sequencing locked: 1 → 2a (U1 + shadow infra) → 2b (stalled + chaser + U4) → 3 → 4 → 5/6 in parallel.
2. Courses Direct: chase Ranjit for HubSpot form URL. Once received: assign `crm_webhook_url` + generate `crm_webhook_token` on `crm.providers.courses-direct`. No further code/schema work needed.
3. Update infrastructure manifest "Last verified" date for `iris-daily-flags` once it has its first scheduled run (08:30 UTC daily).
4. ~~Open switchable/email — update U1 and U4 Brevo templates with referral CTAs~~ — **superseded by email session 12.** Referral content removed from utility emails entirely (legal-basis correction). The full rearchitecture supersedes this work.

## Decisions and open questions

- Owner-test tagging belongs to the canonical DQ path, not a parallel `is_test` column. Decided this session after audit. One mechanism, one source of truth.
- Owner-test allowlist additions: domain (`charlie-harris.com`) chosen over email-by-email because Charlotte's personal domain may be used for multiple addresses. Email entry (`kieranwrites@gmail.com`) used for the gmail-domain case where blanket-matching the domain isn't safe.

## Watch items

- First scheduled `iris-daily-flags` cron run (08:30 UTC daily) — verify it fires and produces flags.
- Courses Direct HubSpot integration remains dormant pending Ranjit's form URL.
- EMS Susan auto-flip billing trigger — first billable enrolment forecast imminent.
- New `admin_update_owner_test_flags` RLS policy is the first UPDATE policy on `leads.submissions` for the `authenticated` role — watch for any unintended writes via other code paths (only `markOwnerTestSubmission` is meant to use it; n8n_writer's existing FOR ALL policy is unaffected).

## Next session

- **Folder:** platform/
- **First task:** Start Phase 1 of the email platform rearchitecture. Four migrations (`crm.email_log`, `crm.consent_history`, `crm.erasure_log`, `crm.access_log`), then `brevo-event-webhook` Edge Function with HMAC signature verification, then configure Brevo webhook in dashboard. Spec is at `platform/docs/email-platform-rearchitecture-spec.md` — already reviewed and amended this session. No further design work needed before code starts.
- **Cross-project:** switchable/email session 12 produced the spec and is now blocked on platform delivering Phase 1 through Phase 3. Once Phase 3 (channel enforcement + backfill) ships, switchable/email returns to build N1/N2/N3 and referral automations in Brevo (Phase 5). Charlotte's parallel task: finish DKIM/SPF/DMARC setup for switchable.org.uk in Brevo (in progress).
