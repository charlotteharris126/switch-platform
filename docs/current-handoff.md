# Platform Handoff, Session 56, 2026-05-21

## Current state

Sheet vocab split shipped, leads.partials cross-form merge fixed, reconcile-sheet-to-db whitelist + audit-wrapper bugs fixed, three more audit-call sites hardened. SMS utility workstream is now FULLY LIVE — all three triggers (fastrack-link cron, save-number on qualify-PASS, chaser on attempt_1) deployed, end-to-end verified via real send to owner's phone, shadow mode flipped to `false`, log table empty of test rows. Next real funded lead routed to a regional-rep provider (today: EMS Tees Valley) will receive real SMS messages per the trigger gates. Lead detail page and leads list both surface SMS history via new UI.

## What was done this session

- **Sheet vocab split.** "Calling" expanded into `Attempt 1 - no answer` / `Attempt 2 - no answer` / `Attempt 3 - no answer` in `_shared/sheet-status.ts` (forward + reverse maps), `sheet-edit-mirror` STATUS_MAP, and `app/lib/sheet-status-sync.ts`. Five EFs redeployed.
- **EMS sheet republished + dropdown updated.** Owner replaced data validation values; 31 "Calling" cells overwritten via Push DB to sheet on /admin/errors.
- **Reconcile panel patched.** Skipped (target_disallowed) IDs now render with sheet status, DB status, clickable admin link. EF response gained `drift_target_disallowed_submission_ids` + `drift_target_disallowed_details`.
- **ALLOWED_TARGET_STATUSES extended.** attempt_1/2/3_no_answer added to reconcile-sheet-to-db's allow-list so per-attempt sheet labels flow sheet to DB through that tool too.
- **BIGINT whitelist coercion bug fixed** in reconcile-sheet-to-db (`Number()` coerce at `.has()` check — postgres@3 returns bigint as string, silently dropping all leads in apply mode pre-fix).
- **Audit call wrapper hygiene.** reconcile-sheet-to-db direct `audit.log_system_action` swapped for `public.log_system_action_v1`. Same pattern applied to route-lead.ts writeAuditSystem, netlify-employer-lead-router auto_route_lead, fastrack-receive mark_outcome_auto_dq. 10 EFs redeployed.
- **Workspace audit (BIGINT + audit-permission classes) — all clear elsewhere.**
- **EMS unblock SQL.** 8 leads flipped from open to attempt_2_no_answer via Supabase SQL Editor before the whitelist fix landed. Single bulk audit row written.
- **Mable's partials work shipped.** Migration 0155 (composite UNIQUE on session_id + form_name) applied; netlify-partial-capture EF updated. fastrack-funded-v1 and switchable-waitlist-enrichment partials now land as their own rows.
- **Fastrack impact analysis.** 13-day same-window comparison: fastrackers 0% DQ vs 23%, 56% reached outcome vs 17%, 8x active enrolment conversations, 1.4d vs 2.5d lost decisions, 4.2d vs 8.4d meeting bookings. Half the lost outcomes are L3 mismatches (working as designed).
- **SMS utility — FULL workstream shipped.** All three triggers from Wren's `switchable/email/docs/sms-utility-design.md`:
  - **Chunk 1 (foundation):** Migration 0156 (`crm.sms_log` + `crm.providers.sms_utility_enabled` + `crm.providers.sms_chaser_enabled`). New `sendSms` helper in `_shared/brevo.ts`. New `admin-test-sms` EF for verification.
  - **Chunk 2 (Triggers B + C):** Migration 0157 (`crm.fire_sms_chaser_attempt_1` RPC). New `_shared/sms-utility.ts` module with `fireSaveNumberSms` + `fireChaserSms` + body templates + UK phone normalisation. New `resolveRepFirstName` helper + new `SW_PROVIDER_REP_FIRST_NAME` Brevo attribute (23 attrs total, up from 22). `fastrack-receive` step 8.7 wired Trigger B. New EF `sms-chaser-attempt-1` for Trigger C. Server action `markOutcomeAction` calls the RPC on `attempt_1_no_answer` for learner leads.
  - **Chunk 3 (Trigger A):** Migration 0158 (every-minute pg_cron `sms-fastrack-prompt-cron`). New EF `sms-fastrack-prompt-cron` scans for matched funded leads with `sent_to_provider_at` 10-60 min ago, no `fastracked_at`, no prior SMS, provider opt-in. New `fireFastrackLinkSms` + inline `buildFastrackUrlForSms` in `_shared/sms-utility.ts`.
- **SMS copy iterated with owner.** Final bodies: fastrack-link uses "Fastrack your application with this quick form: [link]"; save-number opens with "you've passed the stage 1 eligibility check"; chaser tail extended to "Save their number: [phone]".
- **SMS end-to-end verified.** Three test rows landed in `crm.sms_log` (shadow + real). Real test SMS sent to owner's mobile in ~500ms with `brevo_message_id` populated. Chaser body rendered correctly with regional rep first-name + matrix course title + UK phone in E.164.
- **Lead detail + leads list UI shipped.** `/admin/leads/[id]` gained a new "SMS log" card (columns: triggered, type, recipient phone, status, sent, body, notes). `/admin/leads` "Last chaser" column split into "Last email chaser" + "Last SMS chaser" — same colour-coding rule (red if today/yesterday/2 days ago).
- **SMS shadow mode flipped OFF** (`BREVO_SMS_SHADOW_MODE=false`) — system fully live for any new funded lead routed.
- **Test rows cleaned.** Three test rows in `crm.sms_log` deleted by owner via SQL editor; log is empty as of session close. Audit trail for the test sends sits in this handoff.
- **Commits.** `a9ffcc3` (sheet vocab + panel patch). `e0418ec` (partials migration + reconcile fixes + audit-wrapper hygiene). `962d7c2` (full SMS workstream Chunks 1+2+3 + lead detail UI). All pushed to GitHub.

## Next steps

**PUSH from Mable 2026-05-22 (S69) — Sasha (low priority, not blocking):** /admin/experiments archive section. Currently the dashboard derives "running" status from manifest membership (`manifest != null` per `platform/app/app/admin/experiments/page.tsx:295`); closed experiments disappear from view once the manifest entry is stripped. Want: Active vs Archive split. Archive shows closed experiments with start date, close date, final lead counts per variant, winning-variant call-out, and a link to the canonical YAML where the winner now lives. Source: new `crm.experiments_log` table (or column on existing table) persisting each experiment's history after the manifest entry is removed. Schema design — coordinate with Mira on whether this lives in `crm` schema or `platform_meta`. Fields: `closed_at` + `winner_variant` + `close_reason`. Trigger: lift before a third A/B test launches; with `greater-growth-tees-hero-2026-05` and `construction-hero-deputy-2026-05` both currently active, the next closed experiment will lose visibility.

**Also note (informational, no Sasha action):** Mable shipped business-page A/B infrastructure 2026-05-22 in `scripts/build-business-pages.js` (commit 1610b07). Business pages now opt in via an `experiment:` block on the page YAML with `variant_b.hero` overrides; sibling `_v/b/index.html` artefact + manifest entry appended to the same `/data/experiments.json`. `variant-router.ts` already covered `/*` so no EF change needed.

1. **First-day-live monitoring.** Watch `/admin/leads` "Last SMS chaser" column tomorrow as activity rolls in. Cross-check `crm.sms_log` rows against expected fire conditions for any new funded lead routed to EMS Tees Valley. Specifically: a real fastrack qualify-PASS lands a save-number SMS; a real attempt_1 click lands a chaser SMS; a 10-min-old routed lead landing a fastrack-link SMS.
2. **Diagnose Courses Direct's 0/12 outcome rate.** None of 12 routed CD leads have moved out of open/in-chase in the last 13 days. Not a fastrack issue (CD doesn't get fastracked leads in this window). Likely service or sheet-wiring. Belongs in switchleads/clients with Nell rather than here.
3. **Extend fastrack to self-funded.** Same form logic, same L3/funding/intake reconfirm. Currently only the /funded/thank-you/ page fires fastrack; the self-funded thank-you page never does. Pushed to switchable/site (Mable).
4. **Verify reconcile apply end-to-end on the next real drift case.** Whitelist + audit wrapper fix is deployed but only the SQL-bypass path was exercised today.
5. **Auto-flip cron + day-12 warning email** (carry from S51 / reopened S54 / S55 strategy push). Migration 0097 still unapplied. EMS has 50 leads past 7-day SLA. Pre-conditions still owed: Brevo warning template, provider heads-up emails, Mira's activity-gate framework. S55 push: apply prospectively from 1 June 2026 cutoff.
6. **Remote Edge Function deletion (carry from S54).** `supabase functions delete backfill-referral-fastrack-urls --project-ref igvlngouxcirqhlsrhga`, then same for `backfill-client-nonce`.
7. **Per-provider CPL / CPE / P/L scoreboard (carry from S49).** Still queued.
8. **Infrastructure-manifest update (carry from S54).** Add `brevo-attribute-reconcile-daily`, `drift-digest-daily`, AND now `sms-fastrack-prompt-cron` rows. Remove `dead-letter-alert-hourly`.
9. **Cannot-reach-no-chaser to /admin/errors (carry from S55).** System-reliability signal, belongs on /admin/errors as a reconciler card rather than /admin/actions.
10. **Brevo chaser "Contact already in list" dead_letter spam.** 14 errors today, `invalid_parameter: Contact already in list and/or does not exist`. Treat that error code as a no-op rather than a dead_letter row. Not blocking.

## Decisions and open questions

**Decisions:**

- **Per-attempt sheet labels use human form** (`Attempt 1 - no answer`, not raw enum). Matches sheet vocabulary; raw enum was a mid-session quick-fix and is retired.
- **Chaser cron owns attempt-count auto-increment; sheet is a mirror.** Ping-pong risk low; manual sheet edits override when needed.
- **Reconcile whitelist coercion uses `Number()` at the `.has()` check.** Defensive against postgres@3 returning bigint as string for any ID column.
- **Hygiene pass extended to three audit-call sites even though only one was actively broken.** Same fragile pattern; cheap to fix, real risk reduction.
- **SMS spec reconciliation: defaulted to Wren's S18 decisions log over `sms-utility-design.md` spec doc.** S18 is fresher (locked 2026-05-21); chaser body uses "prime-the-pickup" framing not "call back" CTA; rep attribute is `SW_PROVIDER_REP_FIRST_NAME` first-name-only with dual fallback. Owner picked S18 on Chunk 2 pickup.
- **SMS bodies live in TS template literals, not Brevo templates.** Per spec — less surface area, one fewer env var per variant. Copy edits require code change + EF redeploy.
- **SMS commit landed as one bundle** (962d7c2) covering all three chunks + UI. Earlier commit-boundary plan to keep them separate was overtaken when chunks 2+3 shipped same session.
- **SMS shadow mode OFF as of session close.** System fully live. Justified by full end-to-end verification (shadow + real send) on a clean log table.

**Open questions:**

- **Owner decides: extend fastrack form to self-funded leads?** Pushed to switchable/site.
- **Owner decides: Courses Direct dig — switchleads/clients (Nell) first, or platform routing check first?** Read: switchleads/clients first; come back here only if a wiring issue surfaces.

## Watch items

- **Tomorrow's first real funded lead routed to EMS Tees Valley.** 10 min after routing, expect a `call_reminder_fastrack_link` row in `crm.sms_log`. If they fastrack qualify-PASS, expect a `call_reminder_save_number` row. If a provider portal user clicks "1st no answer", expect a `chaser_call_attempt` row. All real SMS now (shadow off).
- **`sms-fastrack-prompt-cron` first natural fire.** Every minute the cron pings the EF; most minutes nothing's eligible (response: `{scanned: 0, sent: 0, ...}`). `public.vw_cron_runs` shows the pings.
- **Tomorrow's 06:00 UTC sheet-drift-reconcile-daily.** Should emit zero EMS drift rows now that vocabulary is aligned.
- **Next real reconcile panel apply.** Verify whitelist + audit wrapper fix lands cleanly end-to-end (only the SQL-bypass path was exercised today).
- **Mable's short URL resolver `/f/{token}`.** Once shipped, update `buildFastrackUrlForSms` in `_shared/sms-utility.ts:bottom` to emit short form. Trigger A SMS drops from ~240 chars / 2 segments to single-segment.
- **WYK Digital regional contacts not populated.** No regional rep first name + phone on file means WYK funded learners get NONE of the three SMS triggers today (gates fail at "no regional rep phone resolves"). Acceptable for now; flag if WYK volume picks up.
- **Carries from S55 still open:** first-fire verification of three reconciler crons (06:00, 06:15, 06:30 UTC), first real EMS lead's LA-scoped CC routing, live Riverside `auto_route_lead` audit row, /admin/experiments DQ rates render correctly post-backfill, EMS SLA-breach card on /admin/actions, U1 bounces, crm.email_log rows 504-506, first natural Riverside attempt transition by Freya without manual SQL, leads.dead_letter sources `channel_b_sheet_writeback` (S50) + `edge_function_brevo_chase_employer` (S52) staying empty.
- **Carries from S51 still open:** auto-flip cron + day-12 warning (migration 0097 unapplied), `u_fastrack_qualified` row in crm.email_log, invite-claim audit via public.log_system_action_v1, TEST_MODE=false re-verification before any B2B test submission.

## Next session

- **Folder:** `switchleads/clients`
- **First task:** Diagnose Courses Direct's stuck pipeline. 12 routed CD leads in the last 13 days, none moved out of open/in-chase. Verify Marty's sheet, check Nell's outreach state, confirm funded-provider angle still live.
- **Cross-project:** Pushes already in place — `switchable/site/docs/current-handoff.md` (extend fastrack to self-funded + short URL resolver), `switchable/email/docs/current-handoff.md` (SMS chunks shipped notice + spec reconciliation). `switchleads/clients/docs/current-handoff.md` (Courses Direct dig) carried from earlier in session.
</content>
</invoke>