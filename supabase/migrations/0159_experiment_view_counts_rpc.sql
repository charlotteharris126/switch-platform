-- Migration 0159 — ads_switchable.get_experiment_view_counts_v1 RPC
-- Date: 2026-05-23
-- Author: Claude (Mable session, cross-project to platform) with owner sign-off
-- Reason:
--   /admin/experiments shows zero views for the construction A/B even though
--   ads_switchable.page_views holds 19 real rows for it. Root cause: the page
--   does `supabase.schema("ads_switchable").from("page_views").select("experiment_id, variant")`
--   with no .range() or aggregation. supabase-js caps a single SELECT at 1000
--   rows. page_views passed 9711 rows on 2026-05-23 (counselling-tees + smm-tees
--   historical runs accumulated nearly 8000 each). Construction's 19 rows sit
--   far above the first 1000 by primary-key order, so the aggregator never
--   sees them. Greater Growth (1120 views) was also partially truncated.
--
--   Fix at the database, not the client. Server-side aggregation returns at
--   most 2 × num_experiments rows regardless of historical volume. Aggregation
--   runs in the DB where it should — page_views_exp_idx covers the GROUP BY
--   path so this is an index scan, not a sequential scan.
--
--   No client-side pagination workaround. That would scale linearly with view
--   row count and hit the same wall again at 5x volume.
--
-- Related:
--   0068_page_views.sql (table + index this function reads)
--   platform/app/app/admin/experiments/page.tsx (consumer, swapped to .rpc in same session)
--   switchable/site/deploy/netlify/edge-functions/variant-router.ts (producer)
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new SECURITY DEFINER function ads_switchable.get_experiment_view_counts_v1.
--      No DDL on existing tables. No new column, no index, no policy.
--   2. Readers: /admin/experiments page swaps its raw SELECT to .rpc() in the
--      same commit. No other consumer of page_views aggregation exists.
--      readonly_analytics agents (Iris, Mira, Metabase) keep their direct
--      SELECT access on the table via the existing RLS policy from 0068 —
--      this RPC is additive, not a replacement.
--   3. Writers: none (read-only function).
--   4. Schema_version: not affected (DB-internal function, no payload contract).
--   5. Data migration: none.
--   6. New role / policy: none. Function is SECURITY DEFINER and runs with
--      the definer's privileges (postgres) so it can read the table even
--      under the caller's narrower role. admin.is_admin() gate inside the
--      body enforces authorisation. EXECUTE granted to authenticated +
--      readonly_analytics.
--   7. Rollback: DROP FUNCTION in DOWN block. Admin page falls back to the
--      pre-0159 raw SELECT (still broken under the row cap, but no worse
--      than today). Safe to roll back at any point.
--   8. Sign-off: owner 2026-05-23.

BEGIN;

CREATE OR REPLACE FUNCTION ads_switchable.get_experiment_view_counts_v1()
RETURNS TABLE(
  experiment_id TEXT,
  variant       TEXT,
  view_count    BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ads_switchable, admin, public
AS $$
BEGIN
  IF NOT admin.is_admin() THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    pv.experiment_id,
    pv.variant,
    COUNT(*)::BIGINT AS view_count
  FROM ads_switchable.page_views pv
  GROUP BY pv.experiment_id, pv.variant;
END;
$$;

COMMENT ON FUNCTION ads_switchable.get_experiment_view_counts_v1() IS
  'Aggregated A/B page-view counts for /admin/experiments. Returns one row per (experiment_id, variant) with lifetime count. SECURITY DEFINER + admin.is_admin() gate; raises 42501 for non-admin callers. Exists because supabase-js caps a raw SELECT at 1000 rows and page_views grew past that threshold mid-May 2026, silently truncating construction-hero-deputy-2026-05 (and partially Greater Growth) from the dashboard. Index ads_switchable_page_views_exp_idx covers the GROUP BY. Versioned (_v1) per data-infrastructure.md §12. Added migration 0159.';

GRANT EXECUTE ON FUNCTION ads_switchable.get_experiment_view_counts_v1() TO authenticated;
GRANT EXECUTE ON FUNCTION ads_switchable.get_experiment_view_counts_v1() TO readonly_analytics;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- Safe at any time. /admin/experiments would revert to its raw SELECT path,
-- which is functional but row-cap-limited — exactly today's state.
--
-- BEGIN;
-- DROP FUNCTION IF EXISTS ads_switchable.get_experiment_view_counts_v1();
-- COMMIT;
