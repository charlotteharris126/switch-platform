# Platform Handoff, Session 79, 2026-06-24

## Current state
Gaply CAPI and Brevo wiring are both confirmed live. Two migrations shipped (0215 brand check, 0216 subscribe_click constraint). Sheet teardown due 25 Jun is the next immediate platform task.

## What was done this session
- **Decided EF over Stape for Gaply CAPI:** Stape free tier auto-disables on low traffic (silently dropped B2B events for 2 weeks). Direct EF is owned and observable.
- **Migration 0215:** expanded `leads.capi_log.brand` CHECK to include `'labs'`.
- **Migration 0216:** added `'subscribe_click'` to `labs.events.event` CHECK. Labs S4 had added it to the EF's ALLOWED_EVENTS but never updated the DB constraint -- every subscribe_click POST was failing at INSERT.
- **`_shared/meta-capi.ts`:** added `'labs'` to CapiBrand; added optional `eventName` to CapiLeadInput and logCapiSend (defaults to "Lead", backward compatible).
- **`labs-event/index.ts`:** wired CAPI (Lead on signup, Subscribe on subscribe_click) and Brevo contact upsert (signup only) as non-blocking waitUntil background tasks for Gaply events.
- **Secrets:** `BREVO_LIST_ID_GAPLY_WAITLIST=13` set in Supabase project secrets.
- **Verified end-to-end:** Lead → capi_log row 46 (200, events_received=1). Subscribe → capi_log row 47 (200, events_received=1). Brevo upsert → contact confirmed in list 13 with GAPLY_* attrs set.
- **Platform changelog updated** with full entry for this session.
- **Labs handoff pushed** confirming both blockers cleared, ad can launch.

## Next steps
1. **25 Jun sheet teardown (tomorrow):** permanently `cron.unschedule('sheet-drift-reconcile-daily')` (jobid 20, currently paused), strip sheet-append side effect from `fastrack-receive`, retire sheet reconcile panel in `/admin/errors`.
2. **Verify B2C CAPI fix** on next organic DQ lead: `is_dq=true` row in leads.submissions with NO new Lead row in leads.capi_log.
3. **Check lead #601:** enrolled (EMS-set 19 Jun) but billed_amount is null. Charlotte emailing EMS tomorrow.
4. **Revoke leaked GitHub PAT** (quick-win, flagged by Sasha, unseen by Charlotte).

## Decisions and open questions
- EF over Stape for Gaply CAPI: decided this session (see reasoning above).
- Test data in labs.events (rows 12, 14, 15) and capi_log (rows 46, 47) from Sasha's test sends. Junk emails, no real attribution impact. Can be cleared via a data-ops script if needed but low priority.
- Open (Iris, not platform): does the funded adset need a learning-phase reset after ~10 false conversions? Charlotte carries this question to Iris.

## Watch items
- **25 Jun deadline:** sheet teardown must happen tomorrow -- EMS sheet is being retired.
- `capi-reconcile-daily` will surface Gaply as a new `labs` brand row in its daily email (expected=0, sent=N). Expected, not an alarm.
- Lead #601: billed_amount null, possible un-billed enrolment.

## Next session
- **Folder:** `platform/`
- **First task:** Sheet teardown -- unschedule cron job 20, strip fastrack sheet-append, retire reconcile panel. Due 25 Jun.
- **Cross-project:** Labs handoff (S5) updated this session confirming CAPI + Brevo done, ad can launch.
