# Platform Handoff, Session 25, 2026-05-03

## Current state

Iris stage 2 is live in production. Six new migrations applied (0055-0060 plus 0063+0064 corrective; Mable's 0061 leads_experiment_columns also landed in parallel), three Edge Functions deployed (router + reconcile patched for shared referral helper, iris-daily-flags new), one new pg_cron schedule. The new ads dashboard's data layer (table + two views + populated funding_segment + new metadata columns) is fully built; the daily flag-computation Edge Function ran clean end-to-end and produced one real P2.3 pixel/CAPI drift flag on first execution. Action Centre integration (stage 3) and `/admin/ads` page (stage 4) are the next builds.

## What was done this session

### Morning bug fixes
- 1g paid-lead count audit applied: `parent_submission_id IS NULL` filter added to leads queries on `/admin/profit` (headline + tracker), `/admin/errors` reconciliation card, and `/admin/analytics` blended CPL line (only the metric Iris named as broken). Closes ClickUp 869d4vyjv.
- Migration 0055 applied: corrected the broken referral hook from Session 24's 0054. 0054 created a dead 3-arg overload of `crm.upsert_enrolment_outcome` while production's 6-arg signature went un-hooked. 0055 dropped the dead overload and refreshed the live 6-arg with the `flip_referral_eligible` hook. Verified via pg_proc query.

### Referral programme follow-on
- `processReferral` + `extractRefCode` extracted to `_shared/referral.ts`. Wired into both `netlify-lead-router` (fast path) and `netlify-leads-reconcile` (slow path) so back-filled leads get the same anti-fraud + referral-row insert as fast-path leads.
- `/admin/referrals` page built per Mira's morning re-scope. Three sections (Eligible queue, Manual review queue, Recent paid). Server actions for Mark paid, Approve, Reject. Replaces the dropped Tremendous payout function. Build clean, awaiting first eligible referral to surface real data.
- Mira's morning decision logged: voucher fulfilment v1 = manual Amazon e-gift cards. Tremendous parked until 20+ refs/month sustained.

### Cron incident (resolved)
- Daily 08:00 UTC `meta-ads-ingest-daily` cron had failed with OAuthException code 200 ("API access blocked"). Investigation confirmed token regeneration didn't help. Root cause: Meta App was in Development Mode, triggering recurring owner-re-verify gates that pause API access.
- Charlotte completed App Settings Basic (Privacy/ToS URLs, app icon, DPO section, Data Use, Data Deletion URL) and **published the app**. Brand-new token then worked: function returned 200 with 9 rows upserted. £49.73 partial-day for 2026-05-02 overwritten with full real spend.
- ClickUp 869d4xtng tracks the remaining un-publish work (Business Verification, App Review). Step 1 effectively done.

### Schema housekeeping (carryovers cleared)
- `infrastructure-manifest.md`: added `meta-ads-ingest` Edge Function row, `meta-ads-ingest-daily` cron row, `iris-daily-flags` Edge Function row, `iris-daily-flags` cron row, `iris_writer` Postgres role row, `META_ACCESS_TOKEN` + `META_AD_ACCOUNT_ID` secret rows.
- `secrets-rotation.md`: added `META_ACCESS_TOKEN` and `iris_writer` rows. Logged Tremendous-secrets-not-added rationale.
- `supabase/README.md`: added Exposed Schemas dashboard-step note.
- `supabase migration repair --status applied 0048 0050 0051 0052 0053 0054 0055` ran clean (Charlotte's terminal).

### Iris dashboard stage 1 (full schema layer)
- Migration 0056 applied: `ads_switchable.iris_flags` table + `iris_writer` role + RLS policies + soft CHECK constraints on severity/automation. Initial sequencing bug (CREATE POLICY referenced role before CREATE ROLE) caught and fixed before re-apply.
- Migration 0057 applied: `ads_switchable.v_ad_to_routed` view (101 rows). All count columns use `parent_submission_id IS NULL` for True CPL consistency.
- Migration 0058 applied: `ads_switchable.v_ad_baselines` view (23 rows). Three CTEs for launch / 7d / 3d windows.
- Migration 0059 applied: `funding_segment` backfill + BEFORE INSERT/UPDATE trigger that derives from `campaign_name` (SW-FUND-* → funded, SW-PAID-* → self-funded, SW-LOAN-* → loan-funded). Backfill: 66 funded + 35 self-funded.
- Migration 0060 applied: 5 new nullable columns on `meta_daily` (`delivery_state`, `daily_budget`, `status`, `headline`, `primary_text`). Existing rows NULL until backfill.

### Iris dashboard stage 2 (Edge Function live)
- `iris-daily-flags` Edge Function written and deployed. Implements all four checks (P1.2 fatigue, P2.1 daily health, P2.2 CPL anomaly, P2.3 pixel/CAPI drift) with 7-day suppression, idempotent same-day re-runs, graceful P2.1 degradation while 1d columns are NULL.
- Two corrective migrations needed mid-deploy: 0063 (GRANT iris_writer TO postgres WITH SET TRUE INHERIT TRUE — Postgres 16+ split membership flags meant default-grant didn't include SET/INHERIT, blocking SET LOCAL ROLE) and 0064 (RLS read policy for readonly_analytics on iris_flags — agents/MCP couldn't see rows otherwise). Both originally numbered 0061/0062 in this session; renamed to 0063/0064 mid-handoff after discovering Mable's parallel 0061 collision. Plus an in-function rename (`window` is reserved word → `period`) and a JS-ternary-in-SQL fix.
- Cron `iris-daily-flags` scheduled at `30 8 * * *` UTC via data-ops/012. Job ID 10. Live.
- First test produced one real P2.3 drift flag (severity red): Meta reported 3 leads vs DB 4 (33% drift) on 2026-05-02; Meta 4 vs DB 6 (50% drift) on 2026-05-01.

### Memory + ticketing
- Memory saved: `feedback_query_live_pg_proc_before_patching.md` (Session 24's 0054 lesson on querying live function signatures before CREATE OR REPLACE).
- Memory saved: `feedback_meta_api_settlement_window_overstated.md` (corrected my own incorrect "Meta takes 24-72h to settle" framing — closed-day data is final next morning).
- ClickUp 869d4xtng created: Meta app un-publish three-stage path. Step 1 effectively done in this session.

## Next steps

1. ~~**Investigate the live P2.3 drift signal.**~~ **Done in this session (post-handoff investigation).** Root cause: form's hidden inputs don't capture `_fbp`, `_fbc`, or `event_id`. Across 109 paid-lead rows over the last 14 days, all three fields are NULL on every submission. Only `fbclid` (URL param) is captured. Result: CAPI events arrive at Meta with no shared event_id (over-count days) and no browser identifier (under-count days). Drift is bidirectional, range -71% to +33% over 14 days. Pushed to Mable in `switchable/site/docs/current-handoff.md` as her Next Steps #0 with full fix scope (read `_fbp`/`_fbc` cookies into hidden inputs at submit, generate per-submit `event_id` UUID, wire same value to pixel `eventID` parameter and CAPI). Iris notified in `switchable/ads/docs/current-handoff.md` that P2.3 will keep firing red until Mable ships the fix; recalibrate after.
2. **Stage 1d backfill: meta-ads-ingest function patch.** Patch the function to request `effective_status`, `status` at the insights level + creative endpoint hits per ad for `headline`/`primary_text` + adset/campaign join for `daily_budget`. Then trigger a 30-day re-pull. Until this lands, P2.1 daily health check sits idle. Non-trivial: separate API endpoints, multiple round-trips per ad. Should be its own session focus.
3. **Iris stage 3: Action Centre integration.** Surface `iris_flags WHERE notified = true AND read_by_owner_at IS NULL` on `/admin/actions` (or wherever owner reviews). Mark-resolved button stamps `read_by_owner_at`. The P2.3 flag from this session would be the first one to display.
4. **Iris stage 4: `/admin/ads` page.** Largest single chunk (per stage spec). Headline tile row, signals card, performance table per-ad, drill-down side drawer. Reads from `meta_daily`, `v_ad_to_routed`, `v_ad_baselines`, `iris_flags`. Suggested split: 4a (tiles + table) then 4b (drill-down + trend).
5. **Continue Meta app un-publish work** (ClickUp [869d4xtng](https://app.clickup.com/t/869d4xtng)). Step 2: Business Verification on Switchable Ltd via Business Manager Security Centre (1-3 business days for Meta to process). Step 3: App Review for `ads_management` + `ads_read` Advanced Access (5-10 business days). Owner action.
6. **Verify tomorrow's 09:30 BST iris-daily-flags cron run.** First scheduled execution. Confirm via `SELECT id, status_code FROM net._http_response ORDER BY created DESC LIMIT 5` after 08:31 UTC.

## Decisions and open questions

**Decisions made this session:**
- **Voucher fulfilment v1 = manual Amazon e-gift cards.** Mira's morning decision, reverting Session 24's Tremendous-from-launch. Trigger to flip back to Tremendous: 20+ successful referrals/month sustained for 2+ months. Reasoning: strategy unproven, speed-to-launch beats automation, 5-15 vouchers/month manageable manually, lower compliance overhead.
- **Referral admin surface = dedicated `/admin/referrals` page**, not a section in `/admin/actions`. Reasoning: `/admin/actions` is being redesigned in Iris stage 3; placing referrals there now creates a dependency to unwind. Dedicated page is also more extensible as volume grows.
- **Weekly digest email for the referral queue: deferred.** Build only if the queue actually drifts. Daily dashboard checks should suffice at pilot volume.
- **meta-ads-ingest cron stays at 08:00 UTC.** I had wrongly proposed shifting to 14:00 UTC based on overstating the Meta settlement window. Closed-day data is final by next morning (Funnel.io confirms the same pattern). Cancelled the schedule-shift suggestion.
- **Tremendous secrets NOT added to `secrets-rotation.md`.** Per the manual-fulfilment decision; re-evaluate when the trigger fires.
- **`platform/CLAUDE.md` + `agent.md` committed to git** at end of session per "single source of truth wins" — drift between disk and git history was the worse option.

**Open questions:**
- **What's causing the 33%/50% pixel/CAPI drift Iris just flagged?** Genuine signal worth investigating before stages 3-4 surface it prominently. Path of investigation: check Stape CAPI dedup config, check pixel firing on slow `/find-funded-courses` and `/find-your-course` pages, compare against fresh Netlify-side timestamps. May be a `switchable/site` issue.
- **When to schedule Iris stages 3 and 4?** Both are full-session builds. Stage 3 first (Action Centre) gives owner the surface for the existing flags. Stage 4 (`/admin/ads`) gives the bigger review surface but is more work. Suggested order: 3 then 4. Owner decides session-cadence.

## Watch items

- **First scheduled iris-daily-flags cron at 09:30 BST tomorrow** (08:30 UTC 2026-05-04). Verify it ran cleanly; expected: same 1 P2.3 flag (suppressed because last one was within 7 days), zero new P1.2/P2.2/P2.3 flags assuming drift situation persists.
- **Live P2.3 drift signal** (33% / 50%). Real, needs investigation.
- **Stage 1d columns NULL across all rows** until meta-ads-ingest function patch + re-pull lands. P2.1 daily health check sits idle.
- **CLI migration tracking now includes 0056-0064.** Next `db push` will need `migration repair --status applied 0048 0050 0051 0052 0053 0054 0055 0056 0057 0058 0059 0060 0061 0063 0064` (still excluding 0049 HubSpot). Note 0062 is genuinely missing from production (was never numbered) and 0061 is Mable's leads_experiment_columns; my originally-numbered 0061+0062 became 0063+0064 to resolve the collision. Run before next CLI push.
- **The deployed `meta-ads-ingest` function is NOT yet patched for stage 1d fields.** Daily cron continues to populate the original column set only. New columns stay NULL.
- **`platform/agent.md`** committed in this session for the first time. If agent persona needs revision, do it as a deliberate edit, not a re-draft.

## Next session

- **Folder:** `platform/`
- **First task:** Stage 1d backfill — patch `meta-ads-ingest` to request `effective_status`, `status` at insights level + creative endpoint hits per ad for `headline`/`primary_text` + adset/campaign join for `daily_budget`. Then trigger 30-day re-pull. Until this lands, P2.1 daily health check sits idle. Non-trivial: separate API endpoints, multiple round-trips per ad. Plan as the session's lead item.
- **Cross-project:** This session's outcome pushed to two places: Iris stage 2 live + P2.3 calibration heads-up to `switchable/ads/`, and the P2.3 root cause + form-side fix scope to `switchable/site/` (Mable). Both pushes added in step 5 of `/handoff`.
