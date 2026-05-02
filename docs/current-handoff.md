# Platform Handoff, Session 22, 2026-05-02

## Current state

Meta ads ingest is fully live: daily cron pulling Switchable spend into `ads_switchable.meta_daily`, with the admin dashboard surfacing True CPL on Overview and a new `/admin/profit` (formerly `/admin/ads`) page showing weekly tracker, period pills, and custom date range. Lead reconciliation card live on Data health comparing Meta-reported vs DB lead counts. Item 2 (Data health and Actions review) opened but paused mid-question to handle the profit tracker rebuild and device swap.

## What was done this session

- Walked owner through Meta dev app setup (Use Cases now replace single Marketing API product, "Measure ad performance data" is the relevant one), System User token generation with `ads_read` scope, ad account ID capture (746980324475630).
- Set Supabase secrets `META_ACCESS_TOKEN` and `META_AD_ACCOUNT_ID` via Vault paste-destination-first.
- Wrote `data-ops/006_meta_ads_backfill.sql` (Vault-helper auth, no plaintext secrets in iCloud-synced files per Session 9 incident pattern). Backfill 2026-04-19 to 2026-05-02 returned 200, 98 ad-level rows.
- Diagnosed lead-count double-count: Meta returns both umbrella `lead` action_type AND per-source breakdowns; original function summed all (gave 248, real = 124). Patched `meta-ads-ingest/index.ts` to prefer umbrella, fall back to specific. Redeployed. Re-ran backfill, leads = 124, matches Ads Manager. Spend £1,709.95 vs £1,711.31 in Ads Manager (£1.36 / 0.08% drift, normal intra-day attribution).
- Wrote `data-ops/007_meta_ads_daily_cron.sql`. Schedule `'0 8 * * *'` (08:00 UTC, rolling 7-day window, idempotent on `(date, ad_id)`).
- Built Lead reconciliation card on `/admin/errors`. Status logic: DB count <95% of Meta = red "system bug", Meta count <75% of DB = orange "tracking degraded", else green "aligned". Window aligns to Meta's earliest date so DB doesn't get unfairly blamed for older leads.
- Migration 0050: `GRANT USAGE` on schema, `GRANT SELECT` on `ads_switchable.meta_daily`, plus `admin_read_meta_daily` RLS policy for `authenticated`. Mirror of 0047 pattern. Without it the dashboard role couldn't read the rows that `ads_ingest` was writing. Same gap historically prevented manual paste rows from being read either.
- Owner-side config: added `ads_switchable` to Supabase API "Exposed schemas" list (REST API was rejecting the schema as Invalid; not in any migration file, dashboard-only setting).
- Renamed `/admin/ads` → `/admin/profit` ("Profit tracker"). Eventually rolls in fixed costs for full P&L.
- 5 headline tiles on Profit tracker: Spend, Leads (true), CPL, Enrolments, Cost per enrolment.
- Period pills: 2d / 7d / 14d / 30d / Lifetime / Custom (Custom shows two date inputs + Apply button via GET form).
- Tracker section: weekly grouping by default, monthly toggle. Columns: Period, Spend, Leads, Open, Lost, Enrolled, CPL, Cost per enrol. Status mapping: Open = `open + presumed_enrolled`, Lost = `lost + cannot_reach + not_enrolled`, Enrolled = `enrolled`.
- Removed manual paste form, delete button, Meta-CPL tile, Variance tile from Profit tracker (Variance now lives only on Data health Lead reconciliation card).
- Updated Overview Money tile: "Cost per lead" → "True CPL" with secondary note showing Meta CPL beneath.
- Two commits pushed: 091bb72 (initial dashboard changes + ingest fix) and 5dfbd7a (profit tracker rebuild + migration 0050).

## Next steps

1. **Resume Item 2: review Data health and Actions for usefulness.** Owner said both pages "not helpful" at session open. Pending answers from owner on: what's not landing, what question the page should answer, what to cut, what's missing. Apply per page (errors page first, then actions page).
2. **Eyeball the Profit tracker once Netlify finishes (commit 5dfbd7a).** Likely tweaks: status mapping (split Open into Routed-no-outcome vs Unrouted?), Enrolments tile note text ("X open, Y lost" may be busy), bucket label readability.
3. **Update infrastructure-manifest.md** with the new cron `meta-ads-ingest-daily` row (critical=yes if ad spend tracking is critical, else no). Update `secrets-rotation.md` with `META_ACCESS_TOKEN` and `META_AD_ACCOUNT_ID` rotation cadence (Meta tokens set to never expire but the System User tokens can be revoked, doc the procedure).
4. **Document the Exposed Schemas dashboard setting** in `supabase/README.md` so a fresh DB clone knows to add `ads_switchable` and any future schemas to the API exposure list. This was the fourth gotcha (after RLS policy, table grant, schema usage) for getting the dashboard to read a new schema.
5. **Iris hookup later:** Iris (ads agent) is not yet wired into the platform data. When ready, she queries `ads_switchable.meta_daily` via `readonly_analytics` Postgres MCP for CPL trends, creative-level performance, weekly digest. Flag in `switchable/ads/` handoff at the time, not now.
6. **HubSpot two-way (carry over from Session 21):** still paused awaiting Ranjit at Courses Direct. Resume steps in `~/.claude/projects/-Users-.../memory/project_hubspot_integration_pending.md`.

## Decisions and open questions

**Decisions made:**
- True CPL as the primary CPL metric on Overview (Meta CPL kept as secondary note). Reason: True CPL uses our DB ground truth; Meta is cookie-blocked.
- Both Meta and True numbers go on Data health for reconciliation. Reason: lets owner spot tracking degradation vs system bugs at a glance.
- Daily cron at 08:00 UTC with rolling 7-day window. Reason: Meta backdates conversions within their settlement window; pulling a week each day means yesterday's numbers are settled by the time we read them.
- Lead double-count fix prefers `lead` umbrella over per-source breakdowns. Reason: `lead` is Meta's unified deduped count, summing it with subtypes = 2x.
- Profit tracker URL changed to `/profit` (not staying `/ads`). Reason: future fixed-costs roll-up makes "Ad spend" wrong; renaming early is cheaper.
- Kept manual paste form removed entirely (not just hidden). Reason: automation works; dead code rots.
- Variance tile lives only on Data health, not on Profit tracker. Reason: Profit tracker is for owner P&L view; reconciliation belongs with system health.

**Open questions:**
- Status bucket "Open" combines `open + presumed_enrolled + unrouted`. Should unrouted be split out? (We have an Actions section for unrouted; might be redundant on Profit tracker.)
- Profit tracker daily granularity: do we ever need per-day rows in the tracker, or are weekly + monthly enough?
- When SwitchLeads ads launch, do they use a separate ad account ID + a parallel `ads_switchleads.meta_daily` table, or share the schema? (Schema was provisioned for both in 0001.)
- Does SwitchLeads spend belong on the Profit tracker too, or its own page? (Two brands, two P&L views, or one consolidated.)

## Watch items

- **Daily cron `meta-ads-ingest-daily`.** First run is 08:00 UTC tomorrow (2026-05-03). Verify next session via `SELECT id, status_code FROM net._http_response ORDER BY created DESC LIMIT 5;` after 08:01 UTC.
- **Lead reconciliation card on Data health.** Currently shows Meta=124 vs DB=? for window since 2026-04-19. Confirm aligned next session, anything in red is a real bug.
- **CLAUDE.md uncommitted on disk.** Modified file shows template-conformance migration in progress (header changed from `# Platform — Business Data Layer` to `# Platform, Business Data Layer`). Untouched this session, decide separately.
- **`agent.md` untracked on disk.** Sasha's persona file, untracked. Decide separately whether it's ready to commit.

## Next session

- **Folder:** `platform/`
- **First task:** Resume Item 2: Data health and Actions usefulness review. Re-ask the four scoping questions, redesign once owner answers.
- **Cross-project:** None this session. Iris hookup is a future `switchable/ads/` task, not pushed yet because not actionable.
