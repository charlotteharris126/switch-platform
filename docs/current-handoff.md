# Platform Handoff, Session 85, 2026-07-29

## Current state

Built and shipped a new lead-intake path: a Meta **Instant Form** (lead ad) campaign for the Riverside Employer-Lead route. New Edge Function `meta-instant-employer-lead-router` is deployed and live, wired Meta → Make → function → `leads.submissions` → routed to Riverside, proven end-to-end with test leads, and now switched to live (Make scenario ON, `TEST_MODE` off). The S84 clear-cache deploy and the S82 revenue-backfill decision remain open and untouched this session.

## What was done this session

- **Refactor (no behaviour change):** lifted the employer-lead normalise + INSERT + routing_log + `ensure_open_enrolment` + sheet/U1/U2/audit/CAPI fan-out out of `netlify-employer-lead-router/index.ts` into new `_shared/employer-lead-core.ts`. `netlify-employer-lead-router` is now a thin handler over that core (form_name gate, `source_form='s4b-employer-lead-v1'`, `fireCapi=true`). Redeployed, byte-identical behaviour.
- **New EF `meta-instant-employer-lead-router`** (deployed, `verify_jwt=false` in config.toml). Thin handler over the shared core. Three deliberate differences from the Netlify path: (1) auth is a shared-secret header `x-instant-secret` == `META_INSTANT_LEAD_SECRET` (constant-time compare, fails closed if unset), (2) `source_form='s4b-employer-lead-meta-instant-v1'`, (3) `fireCapi=false` (Instant Form is an on-Meta conversion Meta already counts; server CAPI would double-count).
- **No migration.** Reuses existing employer columns; only new thing is the distinct `source_form` string value. Ad-level attribution maps into `utm_content` (ad id), `utm_source='meta'`, `utm_medium='instant_form'`; full body archived in `raw_payload`.
- **Middleware = Make (not Zapier).** Zapier's Webhooks action is paywalled; Make's free tier carries the Facebook Lead Ads trigger + HTTP module and holds Meta's `leads_retrieval` approval, so our own low-trust Meta app is untouched. Scenario: FB Lead Ads (Watch Leads webhook) → HTTP POST (raw JSON, `x-instant-secret` header).
- **Proven end-to-end:** after fixing a trailing-comma JSON error (Make refused to send) and empty test-tool leads, routed test #740 then #741 landed `routing_outcome=routed`, `primary_routed_to=riverside-training`, sector + qualifiers captured, provider notify email received (redirected to owner under `TEST_MODE`).
- **Go-live:** `TEST_MODE`/`OWNER_TEST_EMAIL` unset (real provider emails now reach Riverside), Make scenario toggled ON.
- **Cleanup:** owner ran the delete SQL for test leads 737-740; **741 delete SQL handed to owner this session** (see Next steps 1).
- Changelog entry added (2026-07-29) and updated to deployed/live.

## Next steps

1. **Run the 741 cleanup if not already done.** Routed test #741 created a real Riverside enrolment that would show as "dummy data" in their portal. Delete SQL was handed over this session (submission 741 + children across crm.email_log/enrolments/routing_log etc.). Confirm it ran; the submission-id sequence otherwise carries a harmless gap at 737-741.
2. **First real Instant Form lead check (the one thing testing could not verify).** Test-tool leads have no ad behind them, so `utm_content` (ad id) is unverifiable until a genuine lead lands. On the first real one: confirm the ad id populated `utm_content`, sector + qualifiers came through, it routed to Riverside, and the provider email reached **Riverside** (guard is off). If `utm_content` is blank, the Make token `{{2.adId}}` needs correcting.
3. **Add Make + the new EF to the Notion Tech Stack** (infra-change rule: new tool + new function). Hub task filed.
4. **Clara: review the B2B consent wording** on the Riverside Meta Instant Form before spend scales. Hub task filed.
5. **CARRIED FROM S84 (DO FIRST, owner ~2 min): clear-cache deploy the platform app.** Removes the `DBG-SRV` debug banner still live on Riverside's portal and activates `focus_area` on the admin "View as provider" preview. Netlify → platform app → Deploys → "Clear cache and deploy site" (normal redeploy is not enough for provider/preview routes).
6. **CARRIED FROM S82, main open platform item. Owner decides:** (a) build a revenue-backfill button on `/admin/data-ops` + surface revenue/profit on the tracker, (b) also add sheet edits to `vw_audit_actions`, or (c) leave. ~£2,100 collected but no revenue booked (`billed_amount` null on all enrolments, `crm.billing_events` empty). Then backfill the 14 EMS + 1 WYK billable if a/b.
7. **CARRIED: EMS Google Sheet teardown** blocked (Nick working it); 26 sheet-stale drift rows in `/admin/errors` clear on teardown.
8. **CARRIED: revoke leaked GitHub PAT** (S81). **CARRIED: verify B2C CAPI fix** on next organic DQ lead (S81).

## Decisions and open questions

- **Decision: Make over Zapier over own-webhook.** Zapier paywalls its Webhooks action; own Meta `leadgen` webhook needs `leads_retrieval` approved on our low-trust Meta app (memory `feedback_meta_app_low_trust_endpoint_expansion`, do not expand). Make holds the approval on its own app, free tier covers it, our app stays untouched.
- **Decision: `source_form='s4b-employer-lead-meta-instant-v1'`, no migration, no schema_version bump.** Additive string value; distinct origin so Instant Form vs on-site `/business/` performance is comparable in reporting.
- **Decision: CAPI off for the Instant Form path** (`fireCapi=false`). Meta records the Instant Form submission natively; a server CAPI Lead would double-count, and there's no browser pixel fire so no event_id/fbp/fbc to dedup against.
- **Decision: shared `_shared/employer-lead-core.ts`** so both employer receivers can never drift. Changing it means redeploying BOTH functions.
- **Open (carried S82):** does a provider marking "Presumed Enrolled" ever become billable? Policy call needed before any presumed is billed.

## Watch items

- **First real Instant Form employer lead** is the live verification (see Next steps 2). Guard is OFF, so a real lead's provider email now goes to Riverside (Freya) directly.
- **`utm_content` ad-id mapping unverified** until the first real lead (test tool can't carry an ad id).
- **Test row 741** pending owner cleanup (see Next steps 1) or it pollutes Riverside's portal.
- **CARRIED: `DBG-SRV` yellow debug banner** live on Riverside's portal until the clear-cache deploy lands.
- **CARRIED: Meta spend stale since 1 July** (`ads_switchable.meta_daily`).
- **CARRIED: 26 sheet-stale drift rows** in `/admin/errors`, clear on EMS sheet teardown.

## Next session

- **Folder:** `platform/`
- **First task:** Confirm test lead 741 was cleaned, then check the first real Meta Instant Form employer lead landed clean (ad id in `utm_content`, routed to Riverside, provider email reached Riverside). Then the carried S84 clear-cache deploy and the S82 revenue-backfill owner decision.
- **Cross-project:** None in-repo. The Instant Form itself lives in Meta Ads Manager and the middleware in Make (both external, no workspace folder). Riverside is Nell's client (`switchleads/clients/`) but no action is required there this session.
