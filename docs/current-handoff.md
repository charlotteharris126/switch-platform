# Platform Handoff, Session 24, 2026-05-03

## Current state

Switchable referral programme platform side built and live. Migration 0053 applied (referral data model: `referral_code` + `referrer_lead_id` on `leads.submissions`, new `leads.referrals` table with state machine, three helper functions, two RLS policies, schema bumped to 1.3 across all rows). `netlify-lead-router` deployed with `?ref=` capture, anti-fraud, and referral-row insert running as a `waitUntil` background task. Migration 0054 (eligible-flip hooks into `crm.upsert_enrolment_outcome` + `crm.run_enrolment_auto_flip`) written and provided as paste-ready SQL — application status uncertain, owner indicated "ok done" but no verification was run before close. Eight new ClickUp tickets opened across two strands (5 for the Iris dashboard build per the consolidated `ads-dashboard-scope.md`, 3 for referral programme follow-ups: Clara legal, Tremendous payout function, Iris's 1g paid-lead audit fix).

## What was done this session

### Iris dashboard tickets (consolidated scope)
- Five new tickets opened against the 5-stage `switchable/ads/docs/ads-dashboard-scope.md` (replaced the deleted `iris-platform-delta.md` and `-delta-2.md`):
  - [869d4vty3](https://app.clickup.com/t/869d4vty3) Stage 1a, `iris_flags` table
  - [869d4vtz2](https://app.clickup.com/t/869d4vtz2) Stage 1e, `funding_segment` fix
  - [869d4vu0h](https://app.clickup.com/t/869d4vu0h) Stage 2, `iris-daily-flags` Edge Function
  - [869d4vu18](https://app.clickup.com/t/869d4vu18) Stage 3, Action Centre integration
  - [869d4vu3x](https://app.clickup.com/t/869d4vu3x) Stage 4, `/admin/ads` section
- Existing tickets 869d4ubwq, 869d4ubxc, 869d4ubxv map to stage 1d, 1b, 1c (left as-is, descriptions still reference deleted `iris-platform-delta.md` — flagged but not patched).
- Iris's 1g audit (paid-lead count `parent_submission_id IS NULL` filter) ticketed as [869d4vyjv](https://app.clickup.com/t/869d4vyjv) — affects `/admin/profit`, `/admin/errors`, True CPL calcs. Live business defect (CPL artificially low right now).

### Referral programme — platform build
- Migration 0053 written, reviewed, patched, and applied via Supabase SQL editor. Verified: 0 missing codes, 0 duplicates, 1 distinct schema_version (1.3), `leads.referrals` table exists.
- Migration 0054 written, paste-ready SQL provided to owner. Application status not verified before close.
- `netlify-lead-router/index.ts` extended with `extractRefCode`, `processReferral`, normalisation helpers. Deployed clean (`supabase functions deploy netlify-lead-router --no-verify-jwt`).
- Anti-fraud rules at submission: self-referral by email / phone / postcode-or-LA, duplicate-email already in funnel (with `parent_submission_id IS NULL` filter to allow legitimate re-applications). Flag for soft cap (10 successful per 90 days) sits in `leads.flip_referral_eligible`, not at insert.
- `platform/docs/data-architecture.md` updated: leads.submissions block extended, new `leads.referrals` section, header notes 0053 + schema bump.
- `platform/docs/impact-assessment-2026-05-02-referrals.md` written (Section 8 of data-infrastructure rule).
- `platform/docs/changelog.md` entries for 0053 and 0054.
- Two-pass manual review (no `/ultrareview` available) — one agent on SQL safety, one on doc-to-migration alignment. Surfaced 11 drift items + 3 migration blockers, all patched: BEGIN/COMMIT wrap added, defensive backfill loop, full DOWN block with policy/grant/schema_version reverts, schema_version covers all prior versions, constraint rename for accuracy.

### Cross-project scope alignment
- `strategy/docs/referral-programme-scope.md` updated end-to-end: £25 → £50 throughout, two-sided rejected, switchable.careers → switchable.org.uk segmented (`/find-funded-courses/?ref=` for funded, `/find-your-course/?ref=` for self-funded), 10-per-quarter → 10-per-90-days rolling soft cap as flag-not-block, payout cadence flipped from manual fulfilment to Tremendous from launch, Brevo voucher webhook removed (Tremendous handles delivery).
- Three existing programme tickets prepended with `## SCOPE UPDATE 2026-05-02` blocks correcting £25→£50, two-sided→one-sided framing, Brevo→Tremendous, switchable.careers→switchable.org.uk: parent [869d4ud8t](https://app.clickup.com/t/869d4ud8t), email [869d4udfg](https://app.clickup.com/t/869d4udfg), site [869d4udm6](https://app.clickup.com/t/869d4udm6).
- Three new programme tickets opened: Clara legal [869d4vyfe](https://app.clickup.com/t/869d4vyfe), Tremendous payout function [869d4vygz](https://app.clickup.com/t/869d4vygz), paid-lead audit [869d4vyjv](https://app.clickup.com/t/869d4vyjv).

## Next steps

1. **Verify migration 0054 applied.** Run `SELECT pg_get_functiondef('crm.upsert_enrolment_outcome'::regprocedure)` and grep for `flip_referral_eligible`. If missing, paste the 0054 SQL block from session-23-end into the SQL editor.
2. **Move `processReferral` and helpers to `_shared/referral.ts`, wire into `netlify-leads-reconcile`.** The fast-path coverage is live but reconcile-path leads (rare, fast-path-miss) currently lose referral attribution. ~10 min, single-session fix.
3. **Build `payout-referral-voucher` Edge Function** ([869d4vygz](https://app.clickup.com/t/869d4vygz)). Hourly cron reads `leads.referrals WHERE voucher_status = 'eligible' AND needs_manual_review = false AND voucher_paid_at IS NULL`, calls Tremendous API, updates row to `paid` with `vendor_payment_id` and `vendor_payload`. Gated on owner Tremendous setup (account + funded balance + `TREMENDOUS_API_KEY` and `TREMENDOUS_PRODUCT_ID_AMAZON_UK` in Supabase secrets).
4. **Iris dashboard, stage 1a** ([869d4vty3](https://app.clickup.com/t/869d4vty3)). Foundation, unblocks stages 2 and 3. Single migration: `ads_switchable.iris_flags` table + indexes + RLS + new `iris_writer` role. Then 1b, 1c, 1d (existing tickets) can ship as a second migration. 1e (funding_segment) is independent.
5. **Apply Iris's 1g audit fix** ([869d4vyjv](https://app.clickup.com/t/869d4vyjv)). Add `AND parent_submission_id IS NULL` to every paid-lead count in the dashboard codebase (`/admin/profit`, `/admin/errors`, True CPL calcs). Live business defect — CPL artificially low until fixed.
6. **Run `supabase migration repair --status applied 0048 0050 0051 0052 0053 0054`** before the next migration push so `supabase db push` works cleanly. Do NOT include 0049 (HubSpot, intentionally remote-pending).
7. **Update `infrastructure-manifest.md`** with `meta-ads-ingest-daily` cron row (carry-over from Session 22).
8. **Update `secrets-rotation.md`** for `META_ACCESS_TOKEN`, plus add `TREMENDOUS_API_KEY` once that lands.
9. **Document Exposed Schemas dashboard setting** in `supabase/README.md` (carry-over from Session 22).
10. **HubSpot two-way** still paused awaiting Ranjit at Courses Direct (per project memory, no change).

## Decisions and open questions

**Decisions made this session:**
- **Voucher amount £50, one-sided to referrer only.** Two-sided £30/£30 split rejected — adds fraud surface and risks attracting voucher-shoppers rather than course-curious leads. Friend's incentive is the funded course itself.
- **Soft cap 10 successful in 90 days (rolling), enforced as `needs_manual_review` flag, not block.** Genuine super-referrers stay un-blocked; only suspect patterns get gated. Cap evaluated at eligible-flip moment, not at submission.
- **Tremendous for voucher delivery from launch.** Reasoning: ships in days vs Amazon Incentives Direct (weeks of corporate setup), API-driven, supports UK Amazon vouchers, ~$0.50 per payout fee, recipient picks reward. Brevo's role narrows to lifecycle CTAs only — no voucher delivery via Brevo.
- **switchable.org.uk segmented URLs.** Funded leads link to `/find-funded-courses/?ref=CODE`; self-funded link to `/find-your-course/?ref=CODE`. Same-segment friends cluster in same eligibility bracket; meaningfully stronger than a generic `/refer` page. `/refer` still built as fallback explainer, not primary CTA destination.
- **Anti-fraud at form submission only blocks self-referral and duplicate-email.** Soft cap enforced at eligible-flip, not at submission, so the cap window is rolling and accurate at the time the voucher would actually fire.
- **Crockford base32 (no 0/1/I/L/O) 8-char codes.** ~10^12 codes, no human ambiguity. Auto-generated via BEFORE INSERT trigger; backfilled for all existing rows in 0053.
- **Migration applied via Supabase SQL editor with explicit BEGIN/COMMIT wrap, not `supabase db push`.** Editor doesn't auto-wrap; the explicit wrap makes partial failure impossible. Same call for 0054.
- **Vendor field on `leads.referrals` is generic TEXT, not enum.** Tremendous in v1; field stays generic so we can swap to Amazon Incentives or Tango without migration if economics shift.

**Open questions:**
- Migration 0054 application status. Owner said "ok done" but verification not run. Step 1 of next steps clears this up.
- `netlify-leads-reconcile` referral gap — proper fix is to extract helper to `_shared/referral.ts`. Defer or land now? Bias: land now while context is fresh.
- The complementary "your voucher is on the way" Brevo email (touchpoint 6 in [869d4udfg](https://app.clickup.com/t/869d4udfg)) — useful, or duplicate noise on top of Tremendous's own email? Decide on email build.
- Three existing Iris stage tickets (869d4ubwq, 869d4ubxc, 869d4ubxv) still reference deleted `iris-platform-delta.md`. Patch with addendum or leave (stage labels in the new doc map cleanly).

## Watch items

- **First production lead with `?ref=`** exercises the new router code end-to-end. No fixture test was run; the deploy itself is "compiles and ships". When the first one lands, verify: `leads.referrals` row exists with correct `referrer_lead_id` and `voucher_status`; `leads.submissions.referrer_lead_id` populated on the new row; logs show the expected `referral: lead=N ref_code=X referrer=M → pending` or `→ fraud_rejected (reason)` line.
- **Migration 0054 application** — until verified, the eligible-flip is silent. Friends enrolling produce no voucher.
- **CLI migration tracking** still drifted across 0048, 0050, 0051, 0052, 0053, 0054. Repair before next `supabase db push`.
- **Tomorrow's 08:00 UTC `meta-ads-ingest-daily` cron** (carryover from Session 23). Migration 0052 widened `meta_daily.ctr` so the previously-failing high-CTR rows should now write cleanly. Verify `SELECT id, status_code FROM net._http_response ORDER BY created DESC LIMIT 5` after 08:01 UTC and check `/admin/profit` for 2-3 May spend numbers.
- **`platform/CLAUDE.md` and `platform/agent.md` still uncommitted on disk** per Session 22 watch item. Decision deferred again.

## Next session

- **Folder:** `platform/`
- **First task:** Verify migration 0054 applied (Step 1 above), then move `processReferral` to `_shared/referral.ts` and wire into `netlify-leads-reconcile`. After that, Iris stage 1a if the Tremendous account is still pending; or `payout-referral-voucher` Edge Function if Tremendous is live.
- **Cross-project:** Three programme tickets pushed to other folders' work surfaces this session (Clara, Mable, switchable email). Pushes added to those projects' handoffs in step 5 of this `/handoff` run.
