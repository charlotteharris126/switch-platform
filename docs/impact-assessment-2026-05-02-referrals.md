# Impact Assessment, Referral Programme (Migration 0053)

**Date:** 2026-05-02
**Author:** Sasha (Claude session) with owner review
**Migration:** `platform/supabase/migrations/0053_add_referral_programme.sql`
**Scope:** Adds `leads.referrals` table and extends `leads.submissions` with `referral_code` + `referrer_lead_id`. Adds three functions (`leads.generate_referral_code`, `leads.set_referral_code_default`, `leads.flip_referral_eligible`) and an updated_at trigger.
**Schema version bump:** `leads` v1.2 → v1.3.

---

## 1. What does this change?

Adds platform-side mechanics for a referral programme. Every existing and new lead gets a unique 8-character `referral_code`. When a friend submits the qualifying form via `?ref=CODE`, we capture the referrer link, create a `leads.referrals` row in `pending` status, and run anti-fraud checks. When the referred friend reaches confirmed enrolment (or 14-day presumed-enrolment auto-flip), `leads.flip_referral_eligible(submission_id)` flips the referral to `eligible` and stamps `needs_manual_review = true` if the referrer has hit the 90-day soft cap of 10 successful referrals. An Edge Function then fires a Tremendous payout API call and a Brevo voucher email; on success, status flips to `paid`.

The migration adds the storage and the eligible-flip logic. Anti-fraud checks, ?ref capture, Tremendous integration, and Brevo webhook are Edge Function changes shipped separately.

## 2. What reads from the affected tables?

`leads.submissions` is read by:
- `_shared/route-lead.ts` (every routing decision, Brevo upsert, sheet append)
- `netlify-leads-reconcile` Edge Function (hourly back-fill cron)
- `routing-confirm` Edge Function (owner click handler)
- `meta-ads-ingest` cron (joins for closed-loop attribution)
- Iris's queries (paid-lead counts, drift watch)
- `/admin/profit`, `/admin/errors`, `/admin/actions` dashboard pages
- Mira's strategic SQL (KPI scorecard)
- Metabase dashboards (when they land)

The two new columns (`referral_code`, `referrer_lead_id`) are additive. Existing readers ignore them by default. No consumer breaks.

`leads.referrals` is brand new:
- Read by: dashboard surfaces (Action Centre referral card, future `/admin/referrals`), `payout-referral-voucher` Edge Function (planned), Mira's KPI scorecard
- Write by: `netlify-lead-router` (insert at submission), `crm` enrolment-confirmation hook (flip via `flip_referral_eligible`), `payout-referral-voucher` Edge Function (status → paid)

## 3. What writes to the affected tables?

`leads.submissions` writers:
- `netlify-lead-router` (fast path) — picks up the new `referral_code` via the `BEFORE INSERT` trigger automatically
- `netlify-leads-reconcile` (back-fill) — same trigger applies; no code change needed for the trigger to populate referral_code
- `routing-confirm` — UPDATE-only; unaffected
- Manual SQL backfills — same trigger applies on INSERT

`leads.referrals` writers:
- `netlify-lead-router` (extended in a follow-up Edge Function patch) — INSERT on submission with status=pending
- `crm` enrolment-confirmation hook (extended) — calls `leads.flip_referral_eligible`
- `payout-referral-voucher` Edge Function (new) — UPDATE to status=paid, vendor_payment_id, voucher_paid_at after Tremendous call
- Admin dashboard (manual review clearance, notes) — covered by `admin_update_referrals` policy

## 4. Schema version bumps

- `leads` schema bumped v1.2 → v1.3 on `leads.submissions` (additive change to the table)
- Lead payload schema (`switchable/site/docs/funded-funnel-architecture.md`) does NOT bump — the form payload doesn't change. The `?ref=` query param is captured at the Edge Function layer, not as a form field.
- `leads.referrals` is born at v1.0.

Producers needing update:
- `_shared/ingest.ts` — no change required (referral_code populated by trigger)
- `netlify-lead-router/index.ts` — extend to capture `?ref=` from URL/payload, look up referrer, insert referral row, run anti-fraud checks
- `crm` enrolment-confirmation path — call `leads.flip_referral_eligible(submission_id)` on confirmed/presumed enrolment

Consumers needing update:
- `/admin/actions` — surface eligible referrals needing manual review (Stage 4)
- `/admin/referrals` (new page) — full referrals list, filterable
- Dashboard tile counts — add to KPI scorecard

## 5. Data migration / backfill

Yes. The migration backfills `referral_code` for every existing `leads.submissions` row using `leads.generate_referral_code()` inside a single `UPDATE ... WHERE referral_code IS NULL`. After the backfill the column is locked NOT NULL + UNIQUE.

`referrer_lead_id` stays NULL for legacy rows. Only new submissions arriving via `?ref=` get it set.

No dual-write needed. The trigger ensures every future insert auto-populates `referral_code` if the writer doesn't supply one. Existing Edge Functions don't need code changes for this column.

**Backfill campaign (separate work, not blocking):** Switchable email side will send a one-time launch email to all existing leads with their unique referral link. That's a Brevo automation, not a platform task — gated on this migration shipping.

## 6. New roles / RLS policies

No new role.

New policies on `leads.referrals`:
- `admin_read_referrals` — SELECT for `authenticated` users where `admin.is_admin()`
- `admin_update_referrals` — UPDATE for admin (manual review clearance, notes)
- Service role retains implicit full access
- `readonly_analytics` granted SELECT (Iris/Mira/Metabase)

No new policies on `leads.submissions` — the existing RLS posture covers the additive columns.

## 7. Rollback plan

If a problem surfaces post-migration:
1. **For Edge Function bugs (e.g. wrong code captured):** fix forward in the Edge Function. Migration stays.
2. **For schema bugs (e.g. wrong column type, wrong default):** ship migration 0054 with the correction. Never edit 0053.
3. **For a full revert (catastrophic, all referrals broken and the table needs to disappear):** the DOWN block in 0053 is annotated. It drops the table, indexes, triggers, functions, and columns. Note: this is destructive of any referral rows already in production; take an on-demand backup before running.

The migration is reversible in principle but designed to fix-forward in practice. Rollback is a last resort.

## 8. Sign-off

- **Owner (Charlotte):** scope confirmed in session 2026-05-02 (£50 voucher, soft cap as flag-not-block, anti-fraud rules, switchable.org.uk URLs, Tremendous for delivery, automate from day one with backfill campaign).
- **Mira:** strategic priority confirmed in `strategy/docs/referral-programme-scope.md`. Sequence pinned in platform handoff.
- **Sasha (this session):** scope alignment review and migration authorship.

---

## Pre-apply checklist

Before owner triggers `/ultrareview` and applies to production:

- [ ] Migration applies clean against a fresh local Supabase
- [ ] Backfill produces unique codes across all existing rows (`SELECT COUNT(*) = COUNT(DISTINCT referral_code) FROM leads.submissions`)
- [ ] BEFORE INSERT trigger fires on a manual `INSERT` test
- [ ] Self-referral CHECK constraint blocks an invalid `INSERT` into `leads.referrals`
- [ ] `leads.flip_referral_eligible` is idempotent (call twice, second returns true with no state change)
- [ ] RLS denies a non-admin authenticated user
- [ ] `admin.is_admin()` allows the admin path
- [ ] `readonly_analytics` can `SELECT` from `leads.referrals`
- [ ] Schema version actually flips on existing rows (`SELECT DISTINCT schema_version FROM leads.submissions`)

## Post-apply tasks

- [ ] Expose `leads` schema in Supabase Data API settings (per the recurring memory — new schemas need exposing)
- [ ] Update `platform/docs/data-architecture.md` (in same commit; see the changes in this PR)
- [ ] Add changelog entry to `platform/docs/changelog.md`
- [ ] Notify ClickUp 869d4udfg (Switchable email) and 869d4udm6 (Switchable site) that platform is ready for parallel build
- [ ] Notify Clara (privacy policy + T&Cs amendment) — separate ticket forthcoming
