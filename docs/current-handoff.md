# Platform Handoff, Session 57, 2026-05-23

## Current state

Six fixes shipped in one session, prompted by the morning data-health digest (60 dead_letter rows). All deployed live: partials capture restored after 25h outage, brevo chaser no-op silenced, Riverside portal-to-sheet writeback fixed, DB-to-Brevo Re-sync + Check drift both moved to background-task pattern with poll-for-result, Category-attribute false-positive drift fixed. Greater Growth Tees Valley audit (Mable's new EMS funded course) confirmed all wiring matrix-driven, no platform-side work needed. Charlotte ended the session with a Re-sync in progress and the Category fix awaiting her next Check drift to verify SW_MATCH_STATUS drops from 304/304 to ~0.

## What was done this session

- **Partials hotfix.** `netlify-partial-capture/index.ts` line 124-129 `SELECT SUM(...) ... FOR UPDATE` rewritten to lock raw rows + sum in JS. 187 dead_letter rows had landed over 25h. Smoke-tested with two-call upsert (insert + lock-path update). Commit `01e5a83`, deployed. Live at 18:30 UTC.
- **Greater Growth Tees Valley audit.** Mable's new EMS funded course at `/funded/greater-growth-tees-valley/`. Verified matrix routes cleanly, EMS provider has sms_utility_enabled + sms_chaser_enabled + regional_contacts.by_la covering all 5 Tees Valley LAs, route-lead.ts / sms-utility.ts / labelCourse all matrix-driven (zero per-course hardcoding), form `switchable-funded` reused with `course_id=greater-growth-tees-valley` discriminator. No new Brevo attributes needed. All clear.
- **Brevo chaser no-op fix.** `admin-brevo-chase/index.ts` now treats Brevo 400 `Contact already in list and/or does not exist` as a `skipped` status with reason `already_in_list` instead of writing a dead_letter row. Resolves S56 next-step #10. Deployed.
- **Riverside portal-to-sheet writeback fix.** `app/lib/sheet-status-sync.ts` was sending `body.fields.Status` but the canonical Apps Script `provider-sheet-appender-v2.gs` walks each header column and reads body keys via FIELD_MAP at the top level (matching `fastrack-receive`'s working call shape). The wrapped payload returned HTTP 200 with `updates: 0` silently. Only Riverside surfaced because Jane works portal-only; EMS reps work in the sheet so Channel A (sheet-edit-mirror) covered them. Added soft warnings on `ok: false` or `updates: 0` responses.
- **DB-to-Brevo Re-sync timeout fix.** `brevo-attribute-reconcile/index.ts` gained `async_apply: true` body field. EF wraps the run in `EdgeRuntime.waitUntil(...)` and returns immediately with `{started: true, started_at}`. Completion (success OR failure) writes one row to `leads.dead_letter` with source `brevo_attribute_reconcile_async_result`. Server Action `brevoAttributeReconcileAction` gained `asyncApply` arg; /admin/errors Re-sync button passes it. Solves Netlify's 26s Server Action cap at 300+ drift.
- **DB-to-Brevo Check drift timeout fix.** Mirrored async_apply with `async_check: true` + source `brevo_attribute_reconcile_async_check_result`. Server Action `getBrevoAsyncResultAction` reads the latest result row matching the kicked-off `started_at`. Panel polls every 3s for up to 180s. Both buttons return instantly with a spinner; the full DriftReport / SuccessBox drops in once the background task completes.
- **Category-attribute false-positive drift fix.** Brevo's `GET /v3/contacts` (list) returns Category attributes as the numeric position in the enumeration (1, 2, 3...); `GET /contacts/{email}` (single) returns the label string ("matched"). The canonical projection writes labels. Reconciler walked list endpoint, compared numbers to labels, false-positived every Category attribute as drifted on every contact. SW_MATCH_STATUS stayed at 304/304 for the entire session until c49fe58. Fix: `loadCategoryAttrMap()` fetches `/v3/contacts/attributes` once per run, builds name -> position -> label map for every Category attribute, `translateBrevoCategoryValue()` rewrites list-side numbers to labels before the diff. Charlotte verified the underlying writes were correct all along by spot-checking `holdawilliam@hotmail.com` in Brevo single-contact view (status = matched).
- **Charlotte-side fix (manual).** SW_PROVIDER_REP_FIRST_NAME was missing from Brevo's attribute definitions entirely (added 2026-05-21 with SMS workstream, never created in Brevo dashboard). Charlotte added it as Text. Confirmed working: drift dropped 202 to 136 in the next check.
- **Diagnostic mode added.** `list_attributes: true` body flag on `brevo-attribute-reconcile` returns the live Brevo attribute definitions for inspection.
- **Commits.** `01e5a83` (partials hotfix). `a24f982` (3 data-health fixes: chaser no-op + sheet writeback + async_apply). `2836bf6` (async_check + poll-for-result). `c49fe58` (Category translation). All pushed to GitHub on main.

## Next steps

1. **Verify Category fix worked.** Charlotte clicks Check drift on /admin/errors. `SW_MATCH_STATUS` should drop from 304 to near 0. If it does, the Category translation is correct and the only remaining drift is on a handful of text attributes (FIRSTNAME whitespace, SW_PHONE format, etc.) plus the 60 inactive-provider errors.
2. **Run Re-sync once more.** After Check drift confirms, fire Re-sync to write the remaining drifted attributes (mostly SW_PROVIDER_REP_FIRST_NAME 136 + small text attrs).
3. **Republish-provider-sheet for Riverside.** Pushes DB state to her Google Sheet in one shot, clears the 11 sheet_drift_detected rows. Use the existing `republish-provider-sheet` Edge Function or admin panel.
4. **Bulk-clean stale dead_letter rows** on /admin/errors: 179 partials (pre-hotfix), 9 brevo_chase (pre-no-op-fix), 11 Riverside sheet_drift (cleared by step 3), 1 daily brevo_attribute_drift (cleared by step 1).
5. **Fix async_apply wall-time so result rows reliably land.** Current behaviour: apply task gets killed by Edge Runtime wall-time before the result-row INSERT runs (300 contacts x 250ms + Brevo API latency = 100-200s+, exceeds the background-task budget). Either reduce batch size + checkpoint/resume across multiple runs, or move to a chunked-apply pattern where each call processes N=50 and returns. Operator pain: "Still running after 180s" with no result row.
6. **Filter inactive providers out of `brevo-attribute-reconcile`.** Today every check returns 60 errors for Courses Direct + WYK Digital (both paused). Inactive provider is a normal pilot state, not an error. Either skip contacts whose primary_routed_to is inactive OR mark them as `skipped_inactive_provider` (not `error`).
7. **Re-check Greater Growth wiring tomorrow.** Mable's course is launching with the 23 July 2026 cohort. First real funded lead routed should pick up Jake/George/Nick by LA, get the fastrack-link SMS at +10 min, render correctly on /admin/leads. Watch the first one land.
8. **Auto-flip cron + day-12 warning email** (carry from S51 / S54 / S55 / S56). Migration 0097 still unapplied. EMS has 50+ leads past 7-day SLA. Pre-conditions: Brevo warning template, provider heads-up emails, Mira's activity-gate framework. S55 push: apply prospectively from 1 June 2026 cutoff.
9. **Remote Edge Function deletion** (carry from S54): `supabase functions delete backfill-referral-fastrack-urls --project-ref igvlngouxcirqhlsrhga`, then `backfill-client-nonce`.
10. **Per-provider CPL / CPE / P/L scoreboard** (carry from S49). Still queued.
11. **Infrastructure-manifest update** (carry from S54 + S56): add `brevo-attribute-reconcile-daily`, `drift-digest-daily`, `sms-fastrack-prompt-cron`. Remove `dead-letter-alert-hourly`.
12. **Cannot-reach-no-chaser** to /admin/errors (carry from S55). Belongs as a reconciler card.

## Decisions and open questions

**Decisions:**

- **Partials hotfix uses raw-row lock + JS sum**, not aggregate FOR UPDATE. Same lock semantics as pre-S56, correct cross-form aggregation. No PG advisory lock needed at pilot volume.
- **Sheet writeback payload shape standardised on top-level keys** (matching fastrack-receive + Apps Script FIELD_MAP loop). No `fields: {}` wrapper anywhere going forward.
- **Async pattern for /admin/errors long-runs:** EdgeRuntime.waitUntil + dead_letter result row + UI polling. Same pattern works for any future EF that exceeds 26s. Daily cron paths stay synchronous (no Netlify cap involved).
- **Category-attribute translation done at diff time**, not at write time. Brevo accepts labels on write; the asymmetry is read-side only.
- **Brevo `Contact already in list` 400 treated as `skipped`, not error**. Resolved S56 next-step #10. The legacy list-add is now best-effort; the transactional chaser send carries the real signal.

**Open questions:**

- **Apply task wall-time:** keep async_apply as one big run + accept the result row may not land, or refactor to chunked apply with checkpoint? Owner picks. Chunked-apply gives reliable UX but requires schema work (a small state-tracking table or checkpoint payload).
- **Inactive providers in reconciler:** skip silently, or surface as `skipped_inactive_provider` so we can see who's getting impacted? Lean towards surface-as-skipped since pause is reversible and the contact data still needs to backfill if/when the provider reactivates.
- **Brevo Category attributes elsewhere in the canonical:** SW_MATCH_STATUS is one. Are there others? Worth grepping route-lead.ts for any other attribute that's a Brevo Category and may have the same list-endpoint number drift. Quick check at session start tomorrow.

## Watch items

- **First Check drift run after c49fe58 deploys.** SW_MATCH_STATUS should drop from 304 to near 0. If it stays at 304, the Category translation has a bug and needs further diagnosis (probably attribute name case-sensitivity in the categoryMap lookup).
- **async_apply result row from Charlotte's session-end Re-sync.** No `brevo_attribute_reconcile_async_result` row landed during this session despite 2+ apply attempts. Apply task is getting killed by wall-time. Expected: row lands eventually OR doesn't land. Either way next-steps step #5 addresses it.
- **Riverside sheet drift will keep firing daily at 06:00 UTC** until republish-provider-sheet runs (next-steps #3). The portal-to-sheet writeback fix prevents NEW drift but doesn't backfill existing.
- **60 "provider inactive" errors per Check drift** — cosmetic, not blocking. Filtered out by next-steps #6.
- **First Greater Growth Tees Valley lead routed.** SMS + email + chaser path should all fire identically to SMM/Counselling Tees Valley leads. Watch `crm.sms_log` for `call_reminder_fastrack_link` 10 min after the first routing.
- **Carries from S55/S56 still open:** first-fire verification of three reconciler crons (06:00, 06:15, 06:30 UTC), first real EMS lead's LA-scoped CC routing, live Riverside `auto_route_lead` audit row, /admin/experiments DQ rates render correctly post-backfill, EMS SLA-breach card on /admin/actions, U1 bounces, crm.email_log rows 504-506, first natural Riverside attempt transition by Freya without manual SQL, leads.dead_letter sources `channel_b_sheet_writeback` (S50) + `edge_function_brevo_chase_employer` (S52) staying empty, auto-flip cron + day-12 warning (migration 0097 unapplied), `u_fastrack_qualified` row in crm.email_log, invite-claim audit via `public.log_system_action_v1`, `TEST_MODE=false` re-verification before any B2B test submission.
- **Test row pollution.** One sasha_test row left in `leads.partials` (id 15920, session_id `f47ac10b-58cc-4372-a567-0e02b2c3d479`, `answers.sasha_test=true`) from the partials hotfix smoke test. Read-only Sasha can't delete. Owner cleanup when convenient.

## Next session

- **Folder:** `platform`
- **First task:** Verify SW_MATCH_STATUS drift dropped to ~0 in the most-recent `brevo_attribute_reconcile_async_check_result` row after c49fe58 deployed. If so, fire Re-sync once to clear remaining drift, then run republish-provider-sheet for Riverside to clear the 11 sheet_drift rows. Then design the async_apply chunking + checkpoint pattern so result rows reliably land.
- **Cross-project:** No new pushes this session. Greater Growth audit was clean — Mable's work fully matrix-compatible. Iris funded-form regression from S68 still un-actioned in `switchable/ads/` (not this session's scope; Mable's S69 handoff already flagged it).
