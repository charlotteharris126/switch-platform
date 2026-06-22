# Platform Handoff, Session 78, 2026-06-22

## Current state
Data-health error list is empty and the sheet-drift cron is paused, so it stays empty. A live CAPI bug that sent DQ leads to Meta as conversions (since 15 Jun) is fixed and deployed, and its daily reconcile is hardened to catch the same shape again. The EMS sheet-vs-DB drift is fully diagnosed: the DB is authoritative (EMS staff mark outcomes in the portal), the sheet is the stale side, and it retires 25 Jun.

## What was done this session
- Diagnosed the EMS sheet drift end to end. Audit (`vw_audit_actions`) proves EMS staff (nick.rodgers, george.taylor, jake.balfour) mark outcomes in the portal; the Google Sheet lags. DB is the trusted side for all 27 drift rows.
- Confirmed the 6 "lost"-vs-sheet-"active" leads (438, 527, 535, 538, 552, 557) are genuinely lost, marked by EMS themselves in the portal. No un-losing. #601 is a real EMS-set enrolment (do not pull sheet->DB, it would erase it).
- Fixed the CAPI DQ bug: added the `(!is_dq || isPrivatePay)` guard to the B2C CAPI Lead block in `netlify-lead-router` (~line 210). Deployed. ~10 genuine false conversions sent 14-20 Jun (13 total minus 2 private-pay + 1 owner test).
- Hardened `capi-reconcile-daily`: `expected` now counts routable leads only (no false "missing" after the fix), plus a new `wrongly_sent` alarm that catches DQ/child CAPI sends. Deployed, verified against live data.
- Fixed the lead-tracker U1 badge: `u1_private` now counts as a welcome, so private leads (656, 661) stop showing a false "missing". Pushed (Netlify).
- Simplified the Data health page: top-of-page summary banner with one-click "Clear all safe rows" (clean/info severity) + a plain "needs you" list. SMS-credit rows excluded from the sweep. Pushed (Netlify).
- Data-op 049 (cleared 30 sheet_drift_detected rows) and 050 (paused `sheet-drift-reconcile-daily` cron via `cron.alter_job`, cleared the refilled 32 + 1 fastrack rows). Both applied by owner. Error list now 0.
- Owner actions done in-session: SMS credits topped up, DB->Brevo re-synced (36 -> 0 drift), EMS sheet-retirement email sent.

## Next steps
1. **25 Jun sheet teardown (next session):** once the sheet is actually retired, permanently `cron.unschedule('sheet-drift-reconcile-daily')` (jobid 20, currently paused) and remove/short-circuit the sheet-append side effect in `fastrack-receive` so `fastrack_side_effect` stops firing at source. Also retire the now-dead Sheet <-> DB reconcile panel in `/admin/errors`.
2. Verify the CAPI fix on the next organic DQ lead: confirm an `is_dq=true` row lands in `leads.submissions` with NO new `Lead` row in `leads.capi_log` (zero-write check; preferred over a deliberate test row under the read-only role).

## Decisions and open questions
- **Trust the DB/portal over the sheet for EMS, always.** Audit proves EMS works the portal; the sheet only ever lags. Decided this session.
- **The 6 "lost" leads stay lost.** EMS marked them lost themselves with reasons (438 = cohort_decline). No EMS question needed.
- **Pause the drift cron now, don't wait for the 25th.** Reconcile has no value once DB is authoritative and the sheet is dying; it only made daily noise. Pause is reversible (`active=false`), full unschedule at teardown.
- **CAPI keeps private-pay as a conversion** (`isPrivatePay` bypasses the DQ guard) because it is a real paying conversion.
- Open (Iris, not platform): does the funded adset need a learning-phase reset after ~10 false conversions? Flagged to Charlotte to put to Iris.

## Watch items
- Lead #601: DB says `enrolled` (EMS-set 19 Jun) but `billed_amount` is null. Possible un-billed enrolment, worth a billing check (not drift).
- `capi-reconcile-daily` will fire one alarm email covering the pre-fix DQ sends until the 25h window rolls past them, then go silent. Expected, not a new fault.
- Two Netlify deploys from this session (tracker fix, Data health banner) should be confirmed live on next visit to `/admin/leads` and `/admin/errors`.

## Next session
- **Folder:** platform
- **First task:** On/after 25 Jun, run the sheet teardown: permanently unschedule cron jobid 20, strip the sheet-append side effect from `fastrack-receive`, retire the Sheet <-> DB reconcile panel. Otherwise, verify the CAPI fix on the next organic DQ lead.
- **Cross-project:** None. All work this session was platform-internal. The Iris learning-phase-reset question is carried by Charlotte, not pushed to a folder (per the "Charlotte carries agent-to-agent messages" rule).
