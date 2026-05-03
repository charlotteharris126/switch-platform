-- Migration 0060 — Iris stage 1d: extend meta_daily with ad metadata columns
-- Date: 2026-05-03
-- Author: Claude (Sasha session) with owner review
-- Reason: Add the per-ad metadata columns the stage 2 `iris-daily-flags` Edge
--   Function needs for the P2.1 daily health check (delivery state, budget,
--   status) and that the stage 4 `/admin/ads` performance table needs to
--   display creative previews (headline, primary_text). All nullable so
--   existing rows stay valid; backfill happens in a follow-up after the
--   Edge Function update (separate change, batches with end-of-session
--   deploy) re-pulls historical data with these fields requested.
--
--   Columns added (TEXT/NUMERIC, no CHECK constraints — Meta's value sets
--   evolve and we don't want a new value from Meta to break ingest):
--
--   - delivery_state: Meta's per-ad effective delivery state (e.g. ACTIVE,
--     INACTIVE, LIMITED, ADSET_PAUSED, CAMPAIGN_PAUSED). Source: Meta
--     `effective_status` field at the ad level. Used by P2.1 to flag ads
--     stuck in LIMITED.
--   - daily_budget: numeric pence. Source: campaign or adset daily_budget,
--     joined per ad. Used by P2.1 for pacing checks (spend vs budget).
--   - status: Meta's configured ad status (active/paused/archived/deleted).
--     Source: Meta `status` field. Different from delivery_state; status is
--     what was set, delivery_state is what's actually happening.
--   - headline: ad creative headline text. Source: Meta creative endpoint
--     (separate API hit per ad). Used by `/admin/ads` drill-down preview.
--   - primary_text: ad creative primary text. Same source as headline.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: 5 new nullable columns on `ads_switchable.meta_daily`. No
--      changes to existing columns, indexes, or RLS.
--   2. Readers affected: none — current consumers (`/admin/profit`,
--      `/admin/errors`, `v_ad_to_routed`, `v_ad_baselines`) don't reference
--      these columns. Future stage 2 Edge Function and stage 4 dashboard
--      will read them.
--   3. Writers: meta-ads-ingest Edge Function. Function update follows in a
--      separate deploy to start populating the new columns; until then,
--      INSERTs leave them NULL.
--   4. Schema version: meta_daily has no schema_version column (it was an
--      "external API mirror" table, not a contract-versioned ingest target).
--      No bump needed.
--   5. Data migration: none in this migration. Backfill UPDATE will be a
--      separate step after the function update lands and a re-pull populates
--      raw_payload with the new fields.
--   6. New role/policy: no.
--   7. Rollback: DROP COLUMN ... in DOWN. Destructive on backfilled data
--      after that point — see DOWN block.
--   8. Sign-off: owner (this session).
--
-- Related:
--   ClickUp 869d4ubwq (Iris stage 1d)
--   switchable/ads/docs/ads-dashboard-scope.md (stage 1d spec)
--   platform/supabase/functions/meta-ads-ingest/index.ts (will need patch)
-- =============================================================================

BEGIN;

ALTER TABLE ads_switchable.meta_daily
  ADD COLUMN delivery_state TEXT,
  ADD COLUMN daily_budget   NUMERIC,
  ADD COLUMN status         TEXT,
  ADD COLUMN headline       TEXT,
  ADD COLUMN primary_text   TEXT;

COMMENT ON COLUMN ads_switchable.meta_daily.delivery_state IS
  'Meta effective_status at the ad level (ACTIVE/INACTIVE/LIMITED/ADSET_PAUSED/CAMPAIGN_PAUSED/etc). Used by iris-daily-flags P2.1 daily health check. Populated by meta-ads-ingest from Meta Marketing API. Migration 0060.';
COMMENT ON COLUMN ads_switchable.meta_daily.daily_budget IS
  'Daily budget in account currency minor units (pence for GBP). Sourced from the ad''s adset (or campaign if adset has no budget). Used by iris-daily-flags P2.1 spend-pacing check. Migration 0060.';
COMMENT ON COLUMN ads_switchable.meta_daily.status IS
  'Meta configured ad status (active/paused/archived/deleted). Different from delivery_state — status is what was configured, delivery_state is what is actually happening. Migration 0060.';
COMMENT ON COLUMN ads_switchable.meta_daily.headline IS
  'Ad creative headline text. Sourced from Meta creative endpoint (separate API hit per ad). Used by /admin/ads drill-down preview (stage 4). Migration 0060.';
COMMENT ON COLUMN ads_switchable.meta_daily.primary_text IS
  'Ad creative primary (body) text. Sourced from Meta creative endpoint. Used by /admin/ads drill-down preview (stage 4). Migration 0060.';

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- Destructive on any backfilled data. If running after a re-pull populated
-- the new columns, take a manual on-demand backup first per
-- .claude/rules/data-infrastructure.md §7.
--
-- BEGIN;
-- ALTER TABLE ads_switchable.meta_daily
--   DROP COLUMN primary_text,
--   DROP COLUMN headline,
--   DROP COLUMN status,
--   DROP COLUMN daily_budget,
--   DROP COLUMN delivery_state;
-- COMMIT;
