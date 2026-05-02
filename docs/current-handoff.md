# Platform Handoff, Session 23, 2026-05-02

## Current state

Big UX session on `/admin/profit`, `/admin/errors`, `/admin/actions`, `/admin/providers/[id]`. Three production deploys + two production migrations. Errors page reframed around "Flag for Claude" (owner cannot fix code-level errors directly, just flags them) with plain-English translations of common technical messages. Action centre gained inline outcome buttons + two new chase sections. Sidebar carries pill badges. Provider page renamed Catch-up to Reporting and gained per-provider Meta spend (proportionally attributed) plus a weekly tracker. A latent bug surfaced and was fixed: `ads_switchable.meta_daily.ctr` was undersized, causing 10 dead-letter rows that have now been cleared. Iris activation brief relayed and same-day actioned by switchable/ads — four of her five P1/P2 automations now active.

## What was done this session

### Profit tracker (`/admin/profit`)
- Fixed Custom date crash (`resolveWindow` threw NaN on `period=custom` without dates).
- Pre-populated Custom date inputs with last-30d defaults.
- Replaced GET form with client component using `router.push()` plus `export const dynamic = "force-dynamic"`.
- Added Enrolment rate tile (enrolled / leads as %) and Enrol % tracker column.
- Tracker section heading reduced to "Tracker, weekly" / "Tracker, monthly" (the windowed suffix was confusing because rows are bucketed).

### Data health (`/admin/errors`)
- Combined Database recon and Lead recon into one Reconciliation card.
- Migration 0051 applied via SQL editor: `GRANT UPDATE ON leads.dead_letter` + `admin_update_dead_letter` policy gated on `admin.is_admin()`. Closed the RLS gap that made Mark resolved silently no-op.
- Hardened `markErrorResolved` and `bulkMarkSourceResolved` with `.select()` to surface 0-rows-updated as explicit error.
- Added plain-English explanations for 8 previously-unmapped sources (`netlify_forms`, `netlify_audit`, `edge_function_provider_email`, `edge_function_crm_push`, `edge_function_meta_ingest_api/fetch/parse/upsert`). They no longer fall back to the generic "Unknown ingestion error".
- New `translateError()` helper turns common Postgres / fetch / rate-limit / auth / constraint patterns into plain English in the row itself; the technical message stays beneath in mono for the audit trail.
- Severity label "Action needed" renamed to "Flag for Claude" with reworded copy throughout. Owner cannot fix code-level errors directly; the action is to flag.
- `ResolveButton` for fix-severity rows is now a one-click `Flag for Claude` button (red), with optional "add context first" link. The audit note is auto-prefixed with "Flagged for next session" so it's greppable.
- `BulkResolveButton` gains an `isFlag` prop; appears on every card now (fix and clean/info). Lets owner clear an entire batch in one action.
- Resolved (recent) capped to past 5 days. Older history stays in the DB.
- `safeBecause` reassurance line per-source on bulk buttons clarifies why bulk dismissal is safe for clean/info severities.

### Action centre (`/admin/actions`)
- Inline `Re-open / Enrolled / Lost` pill buttons on Presumed enrolled rows. Lost expands the four reason pills inline before firing.
- New section: Needs another chase (status=open AND last_chaser_at < now-5d). One-click Re-chase wired to `crm.fire_provider_chaser`.
- New section: Cannot reach, no chaser sent (status=cannot_reach AND last_chaser_at IS NULL). One-click Send chaser.
- Renamed "AI suggestions" to "Awaiting your call".
- New client components: `inline-outcome-buttons.tsx`, `inline-chaser-button.tsx`.

### Sidebar (`components/admin-shell.tsx` + `app/admin/layout.tsx`)
- Pill badge appears next to Actions and Data health when count > 0.
- Counts only sections owner can actually clear: Awaiting your call, Presumed enrolled, Needs another chase, Cannot reach (no chaser sent). Skips Unrouted and Approaching auto-flip.

### Provider reporting (`/admin/providers/[id]/catch-up`)
- Tab and inline copy renamed Catch-up → Reporting. URL kept as `/catch-up`.
- New Meta spend section: total Meta spend, attributed to provider, cost per enrolment, attributed CPL. Attribution = total_spend × (provider_leads / all_leads), matching the Profit tracker denominator.
- New Weekly tracker per provider: leads, enrolled, lost, attributed spend, cost / enrol per ISO week.

### Bug fix: meta_daily.ctr column overflow
- 10 dead-letter rows surfaced (ids 142-151) all `edge_function_meta_ingest_upsert` with `PostgresError: numeric field overflow`. Root cause: `ctr` was `NUMERIC(6, 5)` in migration 0001 (max 9.99999), but Meta returns CTR as a percentage so any low-impression ad with one click overflows.
- Migration 0052 written and applied via SQL editor: `ALTER COLUMN ctr TYPE NUMERIC(8, 5)`.
- The 10 historical dead-letter rows cleared via direct SQL UPDATE (the new bulk-flag UI shipped post-clear; either path works for next time).

### Iris activation
- Scoped which automations Iris can run today (P1.1 weekly brief, P1.2 fatigue, P2.2 CPL anomaly, P2.3 pixel/CAPI drift) using inline SQL against raw tables.
- Owner relayed to switchable/ads same-session; ads side activated all four automations on Iris's persona, scheduled the daily 08:30 UTC pass, and updated `agent.md`. P2.1 daily health remains parked on platform's `meta_daily` field delta.
- ClickUp tickets opened: 869d4ubwq (Ask 3, schema delta), 869d4ubxc (Ask 1, v_ad_to_routed), 869d4ubxv (Ask 2, v_ad_baselines).

### Production deploys
- `84e0c75` — first batch (profit tracker + data health + action centre + provider reporting).
- `73b6e60` — second batch (bug fixes + migration 0051).
- `fcd26ea` — 8 unmapped sources + tracker label v1.
- `80e7344` — Flag for Claude reframe + translateError + migration 0052 + tracker label v2.
- `962fb27` — bulk Flag for Claude button + 5-day resolved cap.
- `de342fd` — handoff (this doc, original write before later commits).

## Next steps

1. **Iris three platform asks** (per `iris-platform-delta.md` sequencing):
   1. ClickUp 869d4ubwq — confirm Ask 3 first: scope `meta_daily` field delta for `daily_budget` (campaign + adset), `delivery_state` (campaign), `status` (ad), `headline`, `primary_text`. Open question: widen `meta_daily` (per-day, every row repeats config) vs sibling tables (`meta_ads`, `meta_adsets`, `meta_campaigns` refreshed on a separate cadence and joined at view level). Sibling-table approach is cleaner because daily_budget and status aren't per-day metrics.
   2. ClickUp 869d4ubxc — build view `ads_switchable.v_ad_to_routed`. Closed-loop join of `meta_daily` to `leads.submissions` (via `utm_content` = `ad_id`) to `leads.routing_log`.
   3. ClickUp 869d4ubxv — build view `ads_switchable.v_ad_baselines`. Per-ad rolling baselines: launch_date, launch_ctr_baseline (first 7 days), rolling_7d_ctr, rolling_7d_cpl, rolling_30d_ctr, current_frequency.
2. **Sanity-check the post-handoff deploys** (commits `fcd26ea`, `80e7344`, `962fb27`):
   - `/errors`: every card has a per-source explanation (no "Unknown ingestion error"), Flag-for-Claude one-click works, bulk flag works.
   - `/profit`: tracker heading reads "Tracker, weekly" / "Tracker, monthly".
3. **Sidebar urgent-error count** (ClickUp 869d4unth, low priority). Surface fix-severity dead_letter count on Actions page + sidebar badge so owner sees urgent errors alongside other actionable items. Bundle with the next bigger Actions or Data health change rather than its own deploy.
4. **Migration tracking drift** (ClickUp 869d4uby9). Run `supabase migration repair --status applied 0048 0050 0051 0052` before the next migration push so `supabase db push` works cleanly. Do NOT include 0049 (HubSpot, intentionally remote-pending).
5. **Update `infrastructure-manifest.md`** with the `meta-ads-ingest-daily` cron row (carry-over from Session 22). Update `secrets-rotation.md` for `META_ACCESS_TOKEN` rotation procedure.
6. **Document the Exposed Schemas dashboard setting** in `supabase/README.md` (carry-over from Session 22).
7. **HubSpot two-way** still paused awaiting Ranjit at Courses Direct (per project memory).

## Decisions and open questions

**Decisions made:**
- Flag for Claude framing on fix-severity rows. Reason: owner is non-technical; "Action needed" implied they had to debug Postgres errors. The new framing makes it explicit that Claude handles the code/migration fix and the owner just flags. Bulk button means a batch (e.g. 10 numeric-overflow rows from one root cause) clears in one click.
- `translateError()` lives in `app/admin/errors/page.tsx` rather than as a shared module. Reason: it's only used in one place today; extract when a second consumer appears.
- Resolved (recent) capped to past 5 days, not configurable. Reason: long-tail audit history belongs in the DB, not the dashboard.
- `meta_daily.ctr` widened to `NUMERIC(8, 5)`, not changed to `NUMERIC` (unbounded). Reason: keeping precision tight surfaces obvious-bad data fast (a CTR of 9999 is still wrong, but caught at write time). 8.5 has 999.99999 headroom which is past any plausible real value.
- Profit tracker tracker label dropped the windowed suffix. Reason: rows are bucketed (week / month) but the heading said "last 30 days", which made owner question whether the bucket label was wrong.
- Migration 0052 applied via SQL editor, not `supabase db push`. Reason: same CLI tracking drift as 0051 — push would also try 0048-0050 and the intentionally-unapplied 0049.
- The 10 numeric-overflow rows cleared via direct SQL (`UPDATE leads.dead_letter SET replayed_at = now()...`) rather than waiting for the bulk-flag UI deploy. Reason: faster path, owner had already run other SQL today, and the new bulk button isn't needed until next batch lands.

**Open questions:**
- Iris Ask 3 sibling-table vs widen-`meta_daily` decision. Sibling table cleaner conceptually (config not per-day metrics), but adds another ingest path to maintain. Decide before building.
- Profit tracker Custom date now defaults to last-30d when no dates are set — confirm that's the right default.
- Sidebar badge updates per-navigation, not realtime. Acceptable, or wire to RealtimeRefresh layer next iteration?
- `translateError()` patterns are based on what's been seen so far. New error patterns will fall through to the generic "Technical error from an external system" line. Decide whether to grow patterns reactively (when owner reports a confusing message) or proactively (bulk-add common Edge Function error shapes).

## Watch items

- Daily cron `meta-ads-ingest-daily`. Tomorrow's 08:00 UTC run is the test for migration 0052 — should write the previously-failing high-CTR rows successfully and back-fill the missing days via the rolling 7-day window. Verify next session via `SELECT id, status_code FROM net._http_response ORDER BY created DESC LIMIT 5;` after 08:01 UTC, and check Profit tracker for the 2 May spend numbers landing.
- Migrations 0051 and 0052 applied via SQL editor; CLI tracking still drifted. Repair next session (ClickUp 869d4uby9).
- `CLAUDE.md` and `agent.md` still uncommitted on disk per Session 22 — decision deferred again.
- Latest deploys (`fcd26ea`, `80e7344`, `962fb27`) — confirm they landed and the new errors-page UX behaves as expected.

## Next session

- **Folder:** `platform/`
- **First task:** Iris Ask 3 (ClickUp 869d4ubwq). Decide schema delta shape — widen `meta_daily` vs sibling tables (`meta_ads`, `meta_adsets`, `meta_campaigns`) — and scope the ingest loop. Then build views 1 and 2 (Asks 1 and 2).
- **Cross-project:** `switchable/ads/` — Iris activation already relayed and actioned same-day in Session 23. No new push this turn. When platform delivers the Iris views and meta_daily delta, return to ads handoff to swap Iris's inline SQL for the views and unblock P2.1 daily health.
