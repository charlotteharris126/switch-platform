# Platform Handoff, Session 70, 2026-06-09

## Current state
Lead-delivery pipeline diagnosed and stabilised. The Netlify -> `netlify-lead-router` webhook has a known ~3% intermittent drop (migration 0202); it became visible once the Sunderland EMS campaign raised volume on 8 Jun, so dropped leads waited up to 10 min for the backup and notifications arrived late/out of order. Session 69's "is the 578 lag a one-off?" question is now answered: it is the recurring webhook flakiness. Mitigated this session: reconcile sweep now every 2 min with a 2-min grace window. Every one of today's leads is verified routed + EMS-notified + learner-emailed + SMS-sent. Root cause is Netlify's delivery layer (not our function/config); mitigated, not eliminated.

## What was done this session
- Diagnosed the lag via `submit_to_insert` timing: healthy leads land in ~2s; affected leads land only on reconcile ticks (72s-7min). Proved the router function is healthy (unauth POST 200 in ~0.85s) and the webhook config is correct (recreating it did not fix it) -> the flaky link is Netlify's outgoing-webhook delivery.
- Migration `0204`: reconcile cron `*/10` -> `*/2` (worst-case recovery ~2-4 min). Verified live (`vw_cron_jobs` = `*/2`, active).
- Redeployed `netlify-leads-reconcile`: 2-min grace window (`GRACE_MINUTES=2`) so the faster sweep does not race the healthy ~97% webhook (was causing false "back-filled" alerts + dropped re-delivered emails); and now actually calls `writeBackfillDeadLetter` (writer existed, was never invoked) -> resolves session 69 step 3 (the alert's "logged in dead_letter" claim is now true).
- Verified end to end via `audit.actions`: all 5 real leads today (575-578, 580) `provider_notified=true` + `sheet_appended=true`; learner `u1_funded` in `crm.email_log`; SMS in `crm.sms_log` all `sent`, no failures. Reconcile-recovered leads (578, 580) also fully notified.
- Confirmed SMS/email follow-ups are cron-driven (read the DB every minute), not webhook-triggered, so they were never broken; only the lead's DB-arrival lagged. Today's SMS all `sent` -> session 69 step 1 (Brevo SMS credits) is effectively confirmed funded.
- Migration `0205`: archived diagnostic test rows 584, 585.
- Wrote `docs/incident-2026-06-09-lead-webhook-lag.md`; logged 0204/0205 + verification in `docs/changelog.md`.
- CROSS-PROJECT (site): the session-68/69 `earnings_band` empty-field bug was fixed and deployed this session (site repo). It was the only funnel field wrapped in a `{{#IF}}` conditional + carrying two failed patches; now mirrors `employment_status`. Confirmed live: leads 577/578/580 landed `earnings_band=under_30k`.

## Next steps
1. Owner + Mira decide the durable fix: add a client-side direct POST from the form to the router (deduped on `client_nonce`/`session_id`) to remove the Netlify-webhook dependency entirely, OR accept the 2-min self-healing backup as sufficient for pilot. Architecture decision, Mira signs off.
2. If durable fix is a go: scope `client_nonce` dedup in `_shared/ingest.ts` (touches every importer -> redeploy all) + CORS on the router for browser POSTs.
3. Dead_letter redesign (ticketed `e2b2615f`, Mira): route drift-notices to their own log table or auto-resolve on write, so the §10 "anything old = a real problem" signal works again.
4. Optional: mirror provider-notification sends into `crm.email_log` (currently only in `audit.actions`); read Netlify's webhook delivery log to confirm failing-vs-not-attempted (dashboard only).
5. Carries: rotate BREVO_API_KEY + ROUTING_CONFIRM_SHARED_SECRET + the 3 leaked creds in `~/.zsh_history` (owner-driven security); ClickUp cutover (wire Rosa/Nell to task-upsert); billing reconciliation (`/admin/billing`).

## Decisions and open questions
- Decision (owner-authorised): speed reconcile to `*/2` + grace window as interim mitigation rather than chase Netlify's flakiness. WHY: removes the user-facing pain (delays, false alarms) now; the root cause is third-party (Netlify) reliability needing a larger change to eliminate.
- Open: is today's lag baseline ~3% flakiness amplified by volume, or a worse-than-usual Netlify spell? Cannot confirm without Netlify's status page / delivery log.
- Open: durable-fix go/no-go (step 1) and dead_letter redesign (step 3) are Mira's calls.

## Watch items
- Next real leads: `submit_to_insert` ~2s (webhook) or <=~4 min (backup); no false "back-filled" alerts on healthy leads. If alarms persist or delays exceed ~4 min, the grace+cron change is not holding.
- Every new lead should show `provider_notified=true` in `audit.actions` + a `crm.email_log` learner row + a `crm.sms_log` row. Spot-check the next few.
- dead_letter row count still climbing from daily drift-notices until the redesign lands.

## Next session
- **Folder:** platform (Sasha)
- **First task:** Take the durable-fix decision (direct-POST vs accept backup) to Mira; if go, scope the `client_nonce` dedup + `_shared/ingest.ts` change.
- **Cross-project:** switchable/site — `earnings_band` fix shipped + deployed this session (pushed to site handoff). Next site task queued: "split-test /business/ like /business/construction/" (site/Mable).
