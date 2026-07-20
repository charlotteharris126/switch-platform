# Platform Handoff, Session 82, 2026-07-09

## Current state
Diagnostic session, no code or schema changes. Confirmed the enrolment pipeline is healthy end to end (EMS sheet edits mirror into the DB in real time) and the profit tracker's enrolment count is accurate. Two real gaps stand: no revenue is booked anywhere in the DB despite ~£2,100 collected, and the profit tracker has no revenue/profit column.

## What was done this session
- **Answered "is the profit tracker / provider data working":** `/admin/profit` enrolment count verified correct (all 21 real enrolled submissions pass its filters; demo excluded). But the page has never had a revenue or profit column, only spend/leads/CPL/cost-per-enrolment. `vw_provider_billing_state` and `/admin/providers` are correct (EMS 21 billable).
- **Revenue reconciliation (owner-confirmed):** real cash = WYK £150 (May) + EMS £1,050 (May) + EMS £900 (June) = £2,100 = 14 billable enrolments x £150. Accrual basis: 15 billable x £150 = £2,250 earned; £2,100 collected; £150 owed (sub #601). First 3 enrolments per provider are free. Presumed excluded from billing.
- **Confirmed revenue is entirely unrecorded:** `billed_amount` null on all 403 enrolments; `crm.billing_events` empty (0 rows). Lead #601 null billing is not unique, the whole table is null.
- **Diagnosed "17->21 enrolled, nothing in audit":** Nick (EMS) works the Google Sheet. Today he updated 35 leads (07:21-08:53+): 15 Attempt 3, 11 Lost, 4 Presumed Enrolled (subs 617, 655, 708, 711 = the 17->21 jump), 5 Attempt 1/2. All mirrored to the DB (`sheet-edit-mirror` working). They do NOT show in the audit trail (`vw_audit_actions`) because that records portal+admin only; sheet edits log to `crm.sheet_edits_log`. Not a bug, two different logs.
- **Corrected an earlier wrong read:** the 4 presumed were NOT a silent cron auto-flip. Nick set "Presumed Enrolled" manually in the sheet. Fully logged. The 4 are not billed (presumed/dispute deadlines null, billing_events empty).
- **Ran `sheet-drift-reconcile-daily` once** (request 105151, via SQL editor, owner fired it) to read EMS's live sheet. Left 26 sheet-stale drift rows in `dead_letter` / `/admin/errors` (expected: DB is ahead of the sheet because DB->sheet republish is also off).
- Updated `.claude/rules/business.md` to record the EMS £900 June pull and the DB-not-booked reconciliation gap.

## Next steps
1. **Owner decides:** (a) build a revenue-backfill button on `/admin/data-ops` and surface revenue/profit on the tracker, (b) also add sheet edits to the audit-trail view (`vw_audit_actions`) so one screen shows all provider activity, or (c) leave for now. Bring the decision before any build.
2. **Revenue backfill (gated on 1a):** populate `crm.billing_events` (one `enrolment_confirmed` row per billable enrolment) + `enrolments.billed_amount`/`billed_at`/`paid_at` for the 14 billable EMS + 1 billable WYK. Accrual £2,250, cash £2,100, #601 owed £150. First 3 per provider = £0 free. Mapping is confirmed (see existing Hub task "Billing reconciliation + /admin/billing"). Write path via `/admin/data-ops` panel, not direct DB.
3. **Sheet teardown still blocked:** EMS has NOT retired the Google Sheet, Nick is actively working it. Teardown (cron job 20 already inactive, strip fastrack sheet-append, retire reconcile panel) cannot complete until EMS moves off the sheet. The 26 drift rows clear when it does.
4. **Revoke leaked GitHub PAT** (carried from S81, still not actioned).
5. **Verify B2C CAPI fix** on next organic DQ lead: `is_dq=true` row with no new Lead row in `leads.capi_log` (carried from S81).

## Inbound from switchable/site (2026-07-20, Mable) — support_role, BUILT, NOT DEPLOYED
New funded course `counselling-skills-support-roles-south-tyneside` (EMS, South Tyneside, intake 25 Aug 2026) adds a `support_role` qualifier step. Course ENTRY requirement, not a funding gate, so no private-pay fork.

Everything below is written and typechecked but NOT applied. See `platform/docs/changelog.md` (2026-07-20) for the full rationale.

**Deploy order when the owner gives the go-ahead:**
1. `supabase db push` — migrations 0224 (submissions column), 0225 (fastrack column), 0226 (widens the `lost_reason` CHECK; without it the fastrack lost-flip throws 23514).
2. Redeploy `netlify-lead-router` AND `fastrack-receive`. Both import changed `_shared` modules (`ingest.ts`, `route-lead.ts`), which bundle at deploy, so both must go even though only one file each changed.
3. Push the admin app for the provider-portal lead-detail field.

Order matters: EF before migration means inserting a column that doesn't exist.

**Verify after deploy:** submit a test lead on the new page, confirm `leads.submissions.support_role_sector` is populated, then run the fastrack and confirm `leads.fastrack_submissions.support_role_reconfirmed` lands and the sector shows on the portal lead detail.

**Owner action, separate:** `crm.providers.regions` for `enterprise-made-simple` is `['tees-valley']` only. EMS now runs courses in Sunderland and South Tyneside. That field is pushed to Brevo as a contact attribute, so learners on both North East pages can be told EMS is a Tees Valley provider. Fix at `/admin/providers/enterprise-made-simple/trust`.

## Decisions and open questions
- **Decision (owner-confirmed this session):** revenue booked on accrual basis (revenue when enrolment confirmed) with cash tracked separately. Mapping: first 3 per provider free; #601 the only earned-but-uncollected.
- **Open:** does a provider marking "Presumed Enrolled" in the sheet ever become billable? Contract says presumed auto-fires billing after a dispute window; operationally billing is not wired at all. Needs a policy call before any presumed is billed.
- **Open (carried):** funded adset learning-phase reset after ~10 false conversions (S79, Iris question).

## Watch items
- **Meta spend stale since 1 July** (`ads_switchable.meta_daily` last row 1 Jul; ads off / ingestion lag). Lifetime spend on the tracker undercounts the last week.
- **No new leads since 2 July** (submissions/routing stop 2 Jul, ads off). Real, not a data fault.
- **26 sheet-stale drift rows** in `/admin/errors` from this session's manual detector run. Expected, clear on teardown.
- **Nick still working the EMS sheet through the day** (said "doing the others in the next hour"). More mirrored status changes expected today.
- Lead #601 billed_amount null, folds into the revenue backfill.

## Next session
- **Folder:** `platform/`
- **First task:** Get the owner's a/b/c decision on the revenue backfill + tracker revenue column, then build per choice (backfill via `/admin/data-ops`).
- **Cross-project:** None. Revenue/billing work is platform-only. `business.md` updated directly this session (EMS £900 June + DB-not-booked note).
