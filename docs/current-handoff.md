# Platform Handoff, Session 23, 2026-05-02

## Current state

Profit tracker custom-date bug fixed and Enrolment rate metric added. Data health page now shows actual error messages inline, requires a typed note for ACTION NEEDED dismissal, and Mark resolved finally persists (RLS gap closed by migration 0051). Action centre gained inline outcome buttons on Presumed enrolled rows plus two new sections (Needs another chase, Cannot reach no chaser sent). Sidebar carries pill badges that count only owner-clearable items. Provider page renamed Catch-up to Reporting and gained a Meta spend (proportionally attributed) section plus a per-provider Weekly tracker. Iris activation brief drafted and relayed to switchable/ads — three of her five P1/P2 automations can run now, P2.1 parked on platform's `meta_daily` field delta.

## What was done this session

- Profit tracker (`/admin/profit`):
  - Fixed Custom date crash. `resolveWindow` was throwing on `period=custom` without dates because `PERIOD_DAYS["custom"]` was undefined → NaN date → toISOString throw → 500 before form rendered.
  - Pre-populated Custom date inputs with last-30d defaults so first click shows usable values.
  - Replaced GET form with a client component using `router.push()` plus `export const dynamic = "force-dynamic"`. Stale-DOM defaultValue issue meant subsequent applies didn't refresh data.
  - Added Enrolment rate tile (enrolled / leads as %) and Enrol % column in the weekly/monthly tracker. Tile grid 5→6, broke into `md:grid-cols-3 lg:grid-cols-6`.
- Data health (`/admin/errors`):
  - Combined Database recon and Lead recon into one Reconciliation card with two sub-sections.
  - Migration 0051 applied: `GRANT UPDATE ON leads.dead_letter` + `admin_update_dead_letter` policy gated on `admin.is_admin()`. Closed the RLS gap that made Mark resolved silently no-op.
  - Hardened `markErrorResolved` and `bulkMarkSourceResolved`: now `.select()` the affected rows and surface 0-rows-updated as an explicit error instead of false success.
  - ACTION NEEDED rows now: show the actual `error_context` inline as a Why-it-failed column, surface an Open lead button when a submission_id is linked, and require a typed note before dismissal so real errors aren't blind-cleared.
  - CLEAN UP / INFORMATIONAL bulk buttons gained per-source `safeBecause` reassurance lines.
  - Default explanation rewritten to point at error_context + Edge Function logs.
- Action centre (`/admin/actions`):
  - Inline `Re-open / Enrolled / Lost` pill buttons on Presumed enrolled rows. Lost expands the four reason pills inline before firing.
  - New section: Needs another chase (status=open AND last_chaser_at < now-5d). One-click Re-chase wired to `crm.fire_provider_chaser`.
  - New section: Cannot reach, no chaser sent (status=cannot_reach AND last_chaser_at IS NULL). One-click Send chaser.
  - Renamed "AI suggestions" to "Awaiting your call".
  - New client components: `inline-outcome-buttons.tsx`, `inline-chaser-button.tsx`.
- Sidebar (`components/admin-shell.tsx` + `app/admin/layout.tsx`):
  - Pill badge appears next to Actions (count) and Data health (errors_unresolved_total) when count > 0.
  - Counts only sections owner can actually clear: Awaiting your call, Presumed enrolled, Needs another chase, Cannot reach (no chaser sent). Skips Unrouted and Approaching auto-flip per owner ask.
- Provider reporting (`/admin/providers/[id]/catch-up`):
  - Tab and inline copy renamed Catch-up → Reporting. URL kept as `/catch-up` to preserve bookmarks.
  - New Meta spend section: total spend, attributed to provider, cost per enrolment, attributed CPL. Attribution = total_spend × (provider_leads / all_leads), matching the Profit tracker denominator so the views reconcile.
  - New Weekly tracker per provider: leads, enrolled, lost, attributed spend, cost / enrol per ISO week.
- Iris activation: scoped which automations can run now (P1.1 weekly brief, P1.2 fatigue, P2.2 CPL anomaly, P2.3 pixel/CAPI drift) using inline SQL against raw tables, vs blocked (P2.1 daily health needs platform's `meta_daily` field delta). Relayed to owner for hand-off to switchable/ads.
- Two production deploys this session: commit `84e0c75` (first batch — profit tracker enrolment rate, data health, action centre), commit `73b6e60` (this batch — bug fixes + provider reporting + migration 0051).

## Next steps

1. Iris three platform asks (next platform session, owner-passed-on per `iris-platform-delta.md`):
   1. Confirm Ask 3 first: scope `meta_daily` field delta for `daily_budget` (campaign + adset), `delivery_state` (campaign), `status` (ad), `headline`, `primary_text`. Not a one-line ALTER — the ingest function needs an extra fetch loop per entity per day. Decide: schema-only with raw_payload fallback, or full ingest + dedicated columns.
   2. Build view `ads_switchable.v_ad_to_routed`. Closed-loop join of `meta_daily` to `leads.submissions` (via `utm_content` = `ad_id`) to `leads.routing_log`. Returned columns per spec.
   3. Build view `ads_switchable.v_ad_baselines`. Per-ad rolling baselines: launch_date, launch_ctr_baseline (first 7 days), rolling_7d_ctr, rolling_7d_cpl, rolling_30d_ctr, current_frequency.
2. Sanity-check this session's deploys once Netlify settles (commit `73b6e60`):
   - Mark resolved actually persists on a Just-clean-up row.
   - ACTION NEEDED row shows the error message inline and requires the note before dismissing.
   - Profit tracker Custom dates change figures.
   - Sidebar pill counts dropped (no longer counting Unrouted / Approaching auto-flip).
   - Provider page tab says Reporting and Meta spend + Weekly tracker render with correct attribution.
3. Migration tracking drift: CLI shows 0048, 0049, 0050 as not-applied to remote even though 0048 and 0050 are live (0049 is intentionally unapplied per HubSpot pause). `supabase migration repair --status applied 0048 0050` would sync without touching 0049. Do this before the next migration push so 0052+ via `supabase db push` works cleanly. 0051 was applied via SQL editor today, same drift now extends to it.
4. Update `infrastructure-manifest.md` with the new cron `meta-ads-ingest-daily` row (carry-over from Session 22 next-step #3) and `secrets-rotation.md` for `META_ACCESS_TOKEN` rotation procedure.
5. Document the Exposed Schemas dashboard setting in `supabase/README.md` (carry-over from Session 22 next-step #4).
6. HubSpot two-way still paused awaiting Ranjit at Courses Direct (per project memory).

## Decisions and open questions

**Decisions made:**
- Mark resolved is one-click for CLEAN/INFO rows (severity-appropriate default note auto-applied), but FIX-severity rows require a typed note. Reason: fix rows are real errors; one-click dismissal was dangerous because it made them feel optional.
- Surface actual `error_context` in a Why-it-failed column instead of hiding it behind a tooltip. Reason: owner reported "no idea what these errors are" — the explanation card alone wasn't enough, the per-row truth had to be visible.
- Sidebar action badge counts only clearable sections. Reason: Approaching auto-flip is informational (cron handles flip regardless), Unrouted is largely auto-routed; counting them meant the badge would never reach zero, which trains the owner to ignore it.
- Per-provider Meta spend uses leads-driven proportional attribution (provider_leads / all_leads × total_spend). Reason: Switchable ad account isn't tagged per provider; this is the only sensible fair share. Matches Profit tracker denominator so the two views reconcile.
- Provider tab kept the URL `/catch-up` while only the label changed to "Reporting". Reason: avoids breaking any saved bookmarks; URL rename can come later if it becomes confusing.
- Migration 0051 applied via Supabase SQL editor (paste-the-block) rather than `supabase db push`. Reason: CLI tracking is out of sync with prod and `db push` would also try 0048 and 0050 (and worse, 0049 which is intentionally unapplied per HubSpot pause).

**Open questions:**
- Does the Iris Ask 3 schema delta belong as a `meta_daily` widening (add columns, ingest pulls them) or a sibling table (`meta_ads`/`meta_adsets`/`meta_campaigns` with periodic refresh, joined at view level)? Sibling table is cleaner because daily_budget and status aren't per-day metrics. Decide before building Ask 3.
- Profit tracker Custom date now defaults to last-30d when no dates are set — confirm that's the right default vs e.g. matching the prior period selection.
- Sidebar badge updates per-navigation, not realtime. If owner is on the Actions page when a new lead lands, the badge won't tick until next nav. Acceptable, or wire to RealtimeRefresh layer?

## Watch items

- Daily cron `meta-ads-ingest-daily`. First run was scheduled 08:00 UTC 2026-05-03. Verify next session via `SELECT id, status_code FROM net._http_response ORDER BY created DESC LIMIT 5;` after 08:01 UTC.
- Migration 0051 RLS policy applied via SQL editor. CLI tracking does not yet reflect it — pair with the 0048/0050 repair next session.
- Commit `73b6e60` deploying on Netlify. Verify the five sanity-checks listed in Next steps.
- HubSpot integration paused awaiting Ranjit (no platform action this session, but carries forward).
- `CLAUDE.md` and `agent.md` still uncommitted on disk per Session 22 — decision deferred again this session, both untouched.

## Next session

- **Folder:** `platform/`
- **First task:** Tackle Iris Ask 3 first per `iris-platform-delta.md` sequencing. Decide schema delta shape (widen `meta_daily` vs sibling tables) and scope the ingest loop, then build views 1 and 2.
- **Cross-project:** `switchable/ads/` — relayed Iris activation brief to owner this session. Iris can now begin P1.1 weekly brief, P1.2 fatigue, P2.2 CPL anomaly, P2.3 pixel/CAPI drift using inline SQL against `meta_daily` + `leads.submissions` + `leads.routing_log` via `readonly_analytics` MCP. P2.1 daily health is parked on this platform's Ask 3 delta. Push appended to `switchable/ads/docs/current-handoff.md` in step 5 of this handoff.
