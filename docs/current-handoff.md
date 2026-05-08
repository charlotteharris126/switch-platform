# Platform Handoff, Session 35, 2026-05-08

## Current state

Fastrack back-end (lead-to-enrol uplift Phase 2) is live end-to-end across all three outcome paths (happy / L3 mismatch DQ / cohort decline DQ). 4 real fastrack submissions landed overnight from 3 unique learners (1 passed, 1 L3-DQ, 1 double-submission ambiguous case unflipped manually by owner). Two reconcile gaps surfaced via Sasha's data-health dashboard and were fixed in the same session: `netlify-leads-reconcile` was back-filling fastrack-funded-v1 submissions as spurious unknown-form rows, and `brevo-consent-reconcile-daily` was tripping a CHECK constraint on `crm.consent_history`. Admin dashboard now surfaces fastrack data on the lead detail page. Repo + origin in sync, working tree clean.

## What was done this session

Fastrack back-end deploy:

- Migration 0087 (Mable's, applied via `db push --include-all`): `leads.fastrack_submissions` table + `client_nonce` and `fastracked_at` columns on `leads.submissions`.
- Migration 0089: extended `crm.enrolments.lost_reason` CHECK with `l3_mismatch_self_reported` and `cohort_decline`. Pre-flight requirement called out in the Session 34 PUSH FROM block.
- Migration 0090: `admin_read_fastrack_submissions` RLS SELECT policy + table-level GRANT for the `authenticated` role. Mirrors migration 0014 pattern. Filled the gap left by 0087, which only granted to `functions_writer` and `readonly_analytics`.
- New `fastrack-receive` Edge Function (8-step pipeline): parse payload schema 1.0, lookup parent via client_nonce, compute l3_mismatch + cohort_decline flags, insert child row in fastrack_submissions, stamp parent.fastracked_at, asymmetric marketing handling (only explicit `true` writes a fresh `crm.consent_history` row), DQ status flip, sheet update via v2 appender's new `update_by_submission_id` mode, dead_letter on side-effect failure, return 200. Deployed `--no-verify-jwt`.
- `netlify-lead-router` patched twice and redeployed: client_nonce write-through in `_shared/ingest.ts` (single field added to CanonicalSubmission interface, normaliser, INSERT column list, INSERT values; new `parseClientNonce` helper); fastrack-funded-v1 ignore filter mirroring the contact filter pattern.
- `netlify-leads-reconcile` patched and redeployed with the same fastrack-funded-v1 filter. Caught when Sasha's daily dashboard surfaced 7 spurious unknown-form rows.
- `provider-sheet-appender-v2.gs` extended in place with `update_by_submission_id` mode (default mode stays append). New FIELD_MAP entries: `fastrackapplicationfilled`, `fastrackdetails`, `lostreason`, plus aliases.
- Owner re-deployed appender on EMS + WYK sheets via Manage Deployments → New version (URLs preserved). Added Fastrack Application Filled + Fastrack Details columns (replaced unused Enrolment date + Charge), and Submission ID column (added late evening after the first real fastrack failed sheet write).
- Per-form Netlify webhook for `fastrack-funded-v1` → `fastrack-receive` wired by owner.
- `form-allowlist.json` source updated; Mable shipped the build + push as part of switchable/site Session 58.
- Mid-test bugfix: removed non-existent `lost_at` column reference from the DQ status flip. Existing pattern uses `status_updated_at`. Caught at DB-query time before Test 2 fired.

Admin dashboard:

- `app/app/admin/leads/[id]/page.tsx` gained a Fastrack submission card after the re-application banner and before the enrolment outcome form. Surfaces cohort confirmed, transport help, docs ready, L3 reconfirmed, marketing opt-in, terms accepted, voice-of-learner intro. Top-of-card badges fire on `l3_mismatch_flag`, `cohort_confirmed=false`, `docs_ready=false`, `transport_help_requested=true`. Header gains a violet "Fastracked" badge whenever `lead.fastracked_at` is set. TypeScript check clean. List-view fastracked indicator deferred.

Drift cron fix:

- `brevo-consent-reconcile-daily` was using `changed_by='system:cron:brevo-consent-reconcile-daily'` and `source='reconcile_brevo_to_db'`, neither in the `crm.consent_history` CHECK constraint allowed sets from migration 0074. The transaction wrapping UPDATE submissions + INSERT consent_history rolled back atomically, so DB stayed at the drifted value for 4 contacts. Patched to use `changed_by='system'` + `source='reconcile_cron'` (both already in the CHECK), with the descriptive cron name and direction moved into the metadata JSON. Redeployed.

Tests:

- All 3 fastrack paths verified end-to-end. Tests 1 + 2 verified pre-Mable-fix. Test 3 (cohort decline) initially blocked on a Netlify-edge frontend issue where POSTs to URLs carrying query params silently dropped; Mable shipped the switchable/site Session 58 fix (POST to clean URL, JS-navigate to DQ-encoded URL after success) and Test 3 re-verified.
- 4 real fastracks: Whitehead (parent 316, passed with docs soft flag), Ryan (parent 322, L3 DQ), Baker (parent 325, double submission within 17 seconds with conflicting L3 answers — first DQ'd her, second clean; owner unflipped enrolment manually).

Cleanup:

- 7 spurious unknown-form rows from the unfiltered reconcile (ids 318/319/320/321/324/326/327) archived via SQL editor. Reversible.
- Mr Whitehead's row in EMS sheet manually filled (Submission ID, Fastrack Application Filled, Fastrack Details). Sheet write failed automatically because the Submission ID column was added after his routing append; future fastracks ride the automatic path.
- Sharnney Baker (parent 325) enrolment unflipped: `status='open'`, `lost_reason=NULL`, `status_updated_at` re-stamped. Owner manually edited her sheet row in lockstep.
- Dead_letter 158 (`fastrack_side_effect`) bulk-resolved by owner via dashboard.

Memory:

- Two new feedback memories: `feedback_preflight_all_columns_referenced` (pre-flight ALL columns the new code path references on provider sheets, not just the new ones being added — append-mode tolerates missing headers, update-mode fails loudly), and `feedback_netlify_form_post_clean_url` (Netlify Forms silently drops POSTs to URLs carrying query params; POST to the clean form action URL and JS-navigate to any encoded redirect URL separately).

Docs:

- `platform/docs/changelog.md`: full session entry covering fastrack deploy + Mable Session 58 cohort_decline fix + Mr Whitehead recovery + the spurious-row archive + drift cron fix.
- `platform/docs/infrastructure-manifest.md`: Last verified date updated, new fastrack-receive row, updated netlify-lead-router row noting client_nonce + fastrack filter, new per-form Netlify webhook row, Apps Script section noting v2 update mode + EMS + WYK redeploys with Submission ID column.

Cross-project:

- Pushed at start of session to `switchable/site/docs/current-handoff.md` (Session 58): cohort_decline diagnostic flow + suspect list. Mable resolved within hours and updated her handoff to Session 59 reflecting the fix shipped.

Commit: `bb93b87` ("Session 34 evening + morning: Fastrack back-end deploy + reconcile drift fix"), 14 files, +1078/-42. Pushed to origin/main.

## Next steps

1. **Verify overnight cron health.** Sasha's data-health dashboard should be clean by morning. Specifically: (a) `brevo_consent_drift_alert` dead_letter row 166 should self-clear after the 04:00 UTC auto-run successfully writes the 4 corrections — if it fires again with the same CHECK-constraint error message, the redeploy didn't take. (b) No new `fastrack_side_effect` dead_letters from any overnight real fastracks (sheet write path now reliable post-Submission-ID-column-fix). (c) The 7 `reconcile_backfill` dead_letter rows for the archived spurious leads can be bulk-resolved by owner via dashboard.

2. **Build receiver Edge Function for `fastrack-cohort-decline-v1` enrichment form.** Cross-project ask from Mable (switchable/site Session 59 next-steps item 1). When a learner declines the cohort on the fastrack form, Mable's planning a waitlist-style enrichment form on the thank-you page (separate Netlify form, not a passive confirmation card). Captures phone (optional), "When could you start?" chips, "What got in the way?" free-text. Needs a new Edge Function analogous to fastrack-receive but writing to a new table (e.g. `leads.fastrack_cohort_declines` or extend `leads.fastrack_submissions` with cohort-decline-specific columns — design call). Coordinate with Mable on payload schema before she ships the form HTML; per the form-name rule the Edge Function + webhook URL must exist before the form name lands in deployed switchable/site HTML.

3. **Function-logic enhancement (low priority): later fastrack submissions for the same parent should override earlier DQ decisions.** Sharnney Baker case (parent 325) showed the gap: first submission L3=yes DQ'd her, second submission 17 seconds later L3=no would have passed; current code doesn't unflip on the second. Owner unflipped manually. If misclick pattern repeats, ship a small UPDATE in fastrack-receive that recomputes status from the latest fastrack child whenever a new one lands for an existing parent. Otherwise leave.

4. **Admin dashboard: list-view fastracked indicator (deferred follow-up).** `/admin/leads/` list page doesn't yet show whether a lead has fastracked. Detail page does. Adding a column or filter on the list is a small follow-up if it'd help owner workflow. Owner's call on whether to ship.

5. **Sheet-write reliability watch (next several real fastracks).** Sheet update via update_by_submission_id mode now exercised live for 2 funded-shape real leads (Aaron + Sharnney landed cleanly automatically; Mr Whitehead recovered manually). Watch `leads.dead_letter` source=`fastrack_side_effect` for any new entries over the next few days.

6. **`platform/docs/data-architecture.md` Fastrack section.** Migrations 0087 + 0089 + 0090 + appender update mode introduce new platform shape. data-architecture.md should gain a Fastrack section describing the parent + child relationship, the asymmetric marketing consent rule, and the sheet-update mode. Doc-vs-prod drift will compound otherwise.

7. **Carry-over: marketing automations launch (owner's call).** Cleared on platform side per Session 34. Awaiting owner to flip on in Brevo dashboard.

8. **Carry-over: `BREVO_TEMPLATE_RE_ENGAGEMENT` template.** Owner-side build in Brevo, set its id in Supabase Vault. Spec in `switchable/email/docs/current-handoff.md` item 9. No deadline (no qualifying contacts for ~6 months).

9. **Carry-over: Lead-to-enrol uplift Phase 2 follow-on (SMS).** SMS helper in `_shared/brevo.ts` mirroring `sendTransactional`. Idempotency design via a new `crm.sms_log` table or extending `crm.email_log` (decide via design doc first). 4-touch sequence T+0 / T+24h / T+5d / T+10d.

10. **Carry-over: HubSpot integration unpause.** When Ranjit replies with the form URL.

11. **Carry-over: Apprenticeship pricing schema split (Riverside dual-route).** Trigger is Kevin signing the activation page sent 5 May.

## Decisions and open questions

### Decisions made this session

- **Test 3 cohort_decline diagnosis pushed to Mable, not debugged on platform side first.** Why: Tests 1 + 2 verified the function code is correct; Test 3 failure was at the wire level (form POST never reached Netlify), which is a frontend-domain issue. Mable diagnosed within hours and shipped the fix.
- **Owner's bad-faith vs misclick judgment on Sharnney Baker (parent 325): unflipped, treat as misclick.** EMS adviser will catch any L3 confusion on the call. Downside of unflipping is small; downside of leaving as DQ when she's eligible is real.
- **Drift correction deferred to tomorrow's auto-run (04:00 UTC) rather than manual trigger tonight.** Owner stuck on the audit-key handover; cron retry semantics are built-in. Self-heals.
- **Spurious unknown-form rows archived (not deleted).** Reversible per data-infrastructure rule (data fixes never delete).
- **Mr Whitehead recovered via manual sheet fill (not curl-replay of fastrack-receive).** Replay would create a duplicate child row in DB. One-off manual fix is cleaner.
- **Sheet UPDATE mode lookup key: Submission ID column.** Future fastracks ride the automatic path now. route-lead.ts had been silently dropping submission_id on append for months because no header matched (append-mode tolerates missing headers, update-mode does not).
- **Appender extended in place (still v2), not bumped to v3.** Additive change, default mode stays append, existing callers unaffected.

### Open questions

- **Cohort-decline enrichment form schema** (cross-project from Mable, Session 59): question set + post-enrichment success state + automation cross-cuts marketing/utility legal-basis lines. Owner to confirm question set; spec automation with `switchable/email/` (and check `feedback_brevo_automation_blocklist_shared.md` memory) before promising automated comms.
- **List-view fastrack indicator on /admin/leads:** ship or skip? Owner's call.
- **Function-logic: should later fastracks override earlier DQ decisions?** Currently no. Ship the fix only if misclick pattern repeats.

## Watch items

- 🔴 First overnight cron runs (04:00 UTC drift retry, plus the standing daily set: sunset 03:00, reconcile 04:00, failure-alert 04:30, stalled 09:00, U4 09:30). Drift retry is the canary for the CHECK-constraint fix. A new CHECK-error dead_letter would mean redeploy didn't take.
- 🟡 First several real fastrack submissions overnight + tomorrow morning. Watch `leads.dead_letter` source=`fastrack_side_effect` for any sheet-write failures. Should be empty.
- 🟡 Mable's switchable/site Session 58 deploy. Daily `netlify-forms-audit` should pass on next firing now that `webhook_url` is set for `fastrack-funded-v1`.
- 🟢 Whitehead (parent 316), Ryan (parent 322), Baker (parent 325): all in EMS sheet with appropriate state. Adviser can pick up tomorrow.
- 🟢 7 `reconcile_backfill` dead_letter rows still in dashboard awaiting bulk-resolve by owner.

## Next session

- **Folder:** platform/
- **First task:** check Sasha's data-health dashboard. Confirm `brevo_consent_drift_alert` (dead_letter 166) self-cleared after the 04:00 UTC auto-run, no new CHECK-constraint errors fired, no new `fastrack_side_effect` dead_letters from overnight fastracks. Then start scoping Mable's cohort-decline enrichment form receiver (Next steps item 2): align with Mable on payload schema, decide table shape (extend `leads.fastrack_submissions` vs new `leads.fastrack_cohort_declines`), draft migration + Edge Function.
- **Cross-project:** outgoing pushed at start of session to switchable/site Session 58 (cohort_decline diagnosis — resolved same evening by Mable). Incoming push from Mable Session 59: receiver Edge Function + form-allowlist webhook URL needed for `fastrack-cohort-decline-v1` (Next steps item 2 above). No new outgoing push from this session.
