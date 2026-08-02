# Platform Handoff, Session 86, 2026-07-31

## ⚡ PUSH FROM Mable (switchable/site) 2026-08-02: business_status migrations applied + 3 EFs deployed; 14-EF sweep outstanding

The EMS York & North Yorkshire Skills Bootcamp launch (switchable/site S87) shipped platform changes straight to production:
- Migrations applied via `supabase db push`: 0233 (`leads.submissions.business_status`), 0234 (`fastrack_submissions.business_status_reconfirmed` + `business_status_mismatch_flag`), 0235 (`crm.enrolments.lost_reason` CHECK += `business_status_mismatch`). All additive; 0235 verified as a proper superset of the live 15-value constraint. Logged in `docs/changelog.md`.
- Deployed `netlify-lead-router`, `netlify-leads-reconcile`, `fastrack-receive` (they carry the `_shared/ingest.ts` + `route-lead.ts` business_status changes). `verify_jwt=false` honoured from config.
- Admin + provider portal lead-detail now render `business_status` (plus the previously-missing `earnings_band` / `support_role_sector`). Both `switch-platform` + `switchable-site` branches merged to `main` + pushed.
- **OUTSTANDING (no live risk, keeps deployed = committed):** 14 other EFs import the changed `_shared` modules and still run the old code. Sweep them: admin-brevo-resync, admin-notify-callback, admin-test-email, backfill-sw-provider-contact-block, brevo-attribute-reconcile, drift-digest-daily, iris-daily-flags, meta-ads-ingest, republish-provider-sheet, routing-confirm, sheet-drift-reconcile-daily, sheet-edit-mirror, sms-chaser-attempt-1, sms-fastrack-prompt-cron.
- **Also parked:** Riverside S4B Instant Form free-text mapping (add the free-text field to the Make.com mapping). Hub tasks NOT filed (capture key permission denied this session).

## Current state

The Meta Instant Form employer-lead campaign is fully live and verified end to end. Instant Form → Make → `meta-instant-employer-lead-router` → routed to Riverside, with real leads now landing (Emma Franklin / Zenco #745, Sam Daramola / SecureDigital #746) carrying real Meta ad ids. The on-site `/business/` funnel is also converting Meta ad traffic (Nick #742, Richard #743). Both employer intake channels feed Riverside cleanly. The S84 clear-cache deploy and the S82 revenue-backfill decision remain open and untouched.

## What was done this session

- **Instant Form taken live and debugged.** Symptom: real Meta leads "stuck at Meta", not reaching the dashboard. Root cause: the Make scenario was never toggled ON (a "Run once" test is not the live scheduling toggle). Turned on; leads now flow.
- **Verified the live path with real leads.** #745 (Emma, Zenco) and #746 (Sam, SecureDigital) came through the Instant Form, routed to `riverside-training`, with real ad ids in `utm_content` (`120247847055060775` etc.). This closes the one thing testing could never prove: the `{{2.adId}}` mapping works on genuine leads.
- **Confirmed two distinct employer intake channels now feed Riverside**, distinguishable by `source_form` + payload shape:
  - `s4b-employer-lead-v1` — on-site `/business/funded-training` form (Meta ad → landing page). Full site fingerprint (page_url, session_id, ~41 fields).
  - `s4b-employer-lead-meta-instant-v1` — Meta Instant Form via Make. ~11 mapped fields, `utm_source=meta`, `utm_medium=instant_form`, `utm_content=ad id`.
- **Cleaned test + duplicate leads.** #744 (Make test lead, dummy data) and #747 (Richard Payne again, a cross-channel duplicate of #743 who had already come via the landing page) deleted with children. Remaining real leads: #742, #743, #745, #746.
- **Notion Tech Stack updated:** Make added as an active tool under Forms and Funnels, removed from Planned, planned line reworded to n8n-only.
- **Hub tasks:** verify-first-lead and add-Make-to-tech-stack both closed; Clara consent-review task still open.

## Next steps

1. **Clara: review the B2B consent wording** on the Riverside Meta Instant Form before spend scales (Hub task open). Instant Forms collect consent inside Meta, not via our site form; privacy link is https://switchable.org.uk/privacy/.
2. **Bump the Notion Tech Stack "Last updated" date** to 29 July 2026 (still shows 5 June). ~2 min manual: Notion's MCP can't edit existing text in place, only add/delete blocks.
3. **CARRIED FROM S84 (DO FIRST, owner ~2 min): clear-cache deploy the platform app.** Removes the `DBG-SRV` debug banner still live on Riverside's portal and activates `focus_area` on the admin "View as provider" preview. Netlify → platform app → Deploys → "Clear cache and deploy site" (normal redeploy not enough for provider/preview routes).
4. **CARRIED FROM S82, main open platform item. Owner decides:** (a) revenue-backfill button on `/admin/data-ops` + revenue/profit on the tracker, (b) also add sheet edits to `vw_audit_actions`, or (c) leave. ~£2,100 collected, no revenue booked (`billed_amount` null on all enrolments, `crm.billing_events` empty). Then backfill 14 EMS + 1 WYK if a/b.
5. **CARRIED: EMS Google Sheet teardown** blocked (Nick working it); 26 sheet-stale drift rows in `/admin/errors` clear on teardown.
6. **CARRIED: revoke leaked GitHub PAT** (S81). **CARRIED: verify B2C CAPI fix** on next organic DQ lead (S81).

## Decisions and open questions

- **Make real-time webhook does not backfill.** The Facebook Lead Ads trigger only catches leads created after the scenario is ON. Leads that arrive while it's off sit in Meta and must be recovered via the Meta Lead Center / form "Download leads" export (that's how Emma and Sam were rescued this session). The scenario being ON is load-bearing, watch it stays on.
- **Cross-channel employer duplicates are expected** now both funnels feed Riverside (an employer can hit the landing page and the Instant Form). Not a billing problem: Employer Signed bills once per employer regardless. It just creates occasional duplicate portal rows. Add same-email intake dedup only if it becomes frequent, not built.
- **Decision: `fireCapi=false` on the Instant Form path** stands (Meta counts the on-form conversion natively; server CAPI would double-count).
- **Open (carried S82):** does a provider marking "Presumed Enrolled" ever become billable? Policy call needed before any presumed is billed.

## Watch items

- **Instant Form leads flowing** via Make (source `meta-instant-v1`). Glance periodically that new ones land and the Make scenario stays ON.
- **CARRIED: `DBG-SRV` yellow debug banner** live on Riverside's portal until the clear-cache deploy lands.
- **CARRIED: Meta spend stale since 1 July** (`ads_switchable.meta_daily`).
- **CARRIED: 26 sheet-stale drift rows** in `/admin/errors`, clear on EMS sheet teardown.
- Submission-id sequence has harmless gaps (deleted test/dupe leads 744, 747, and earlier 737-741).

## Next session

- **Folder:** `platform/`
- **First task:** Glance that Instant Form employer leads are still landing under `s4b-employer-lead-meta-instant-v1` and the Make scenario is on. Then the carried S84 clear-cache deploy and the S82 revenue-backfill owner decision.
- **Cross-project:** None in-repo. The Instant Form lives in Meta Ads Manager and the middleware in Make (both external). Riverside is Nell's client (`switchleads/clients/`) but no action required there.
