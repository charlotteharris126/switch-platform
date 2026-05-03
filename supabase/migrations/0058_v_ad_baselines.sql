-- Migration 0058 — Iris stage 1c: ads_switchable.v_ad_baselines view
-- Date: 2026-05-03
-- Author: Claude (Sasha session) with owner review
-- Reason: Per-ad rolling baselines for the iris-daily-flags Edge Function
--   (stage 2). Provides launch CTR baseline, rolling 7-day CTR + CPL,
--   rolling 3-day CTR + current frequency. Used by:
--     - P1.2 fatigue check: current_frequency > 3.0 AND
--       rolling_3d_ctr < 0.7 * launch_ctr_baseline
--     - P2.2 CPL anomaly check: cpl_24h > 2.0 * rolling_7d_cpl
--   Computed at view layer rather than the Edge Function so the same
--   baselines are queryable ad-hoc from the dashboard or via Postgres MCP.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new view `ads_switchable.v_ad_baselines`. No table changes.
--   2. Readers affected: none yet — view is queryable but no consumer wired
--      until stage 2 Edge Function ships. Granted SELECT to `authenticated`
--      (dashboard) and `iris_writer` (stage 2).
--   3. Writers: n/a — view is read-only.
--   4. Schema version: not affected (no payload contract change).
--   5. Data migration: none.
--   6. New role/policy: no new roles. Grants only.
--   7. Rollback: DROP VIEW in DOWN.
--   8. Sign-off: owner (this session).
--
-- Related:
--   ClickUp 869d4ubxv (Iris stage 1c)
--   switchable/ads/docs/ads-dashboard-scope.md (stage 1c spec)
--   switchable/ads/docs/iris-automation-spec.md (P1.2, P2.2 thresholds)
-- =============================================================================

BEGIN;

CREATE OR REPLACE VIEW ads_switchable.v_ad_baselines AS
WITH ad_first_seen AS (
  -- Launch date per ad — used as the anchor for the launch-window baseline.
  SELECT ad_id, MIN(date) AS launch_date
  FROM ads_switchable.meta_daily
  GROUP BY ad_id
),
launch_window AS (
  -- First 7 days post-launch, used as the "fresh creative" baseline against
  -- which fatigue is measured.
  SELECT
    md.ad_id,
    AVG(md.ctr) AS launch_ctr_baseline,
    SUM(md.impressions) AS launch_impressions
  FROM ads_switchable.meta_daily md
  JOIN ad_first_seen afs ON md.ad_id = afs.ad_id
  WHERE md.date BETWEEN afs.launch_date AND afs.launch_date + INTERVAL '6 days'
  GROUP BY md.ad_id
),
rolling_7d AS (
  -- 7-day rolling window (yesterday and the 6 days prior). Excludes today
  -- because today's data is partial until the next-morning ingest settles
  -- the figures.
  SELECT
    ad_id,
    AVG(ctr) AS rolling_7d_ctr,
    SUM(spend)::NUMERIC / NULLIF(SUM(leads), 0) AS rolling_7d_cpl
  FROM ads_switchable.meta_daily
  WHERE date >= CURRENT_DATE - INTERVAL '7 days'
    AND date < CURRENT_DATE - INTERVAL '1 day'
  GROUP BY ad_id
),
rolling_3d AS (
  -- 3-day rolling window for current-frequency + recent CTR signal. Includes
  -- the most recent ingested day so fatigue spikes show up quickly.
  SELECT
    ad_id,
    AVG(ctr) AS rolling_3d_ctr,
    AVG(frequency) AS current_frequency
  FROM ads_switchable.meta_daily
  WHERE date >= CURRENT_DATE - INTERVAL '3 days'
  GROUP BY ad_id
)
SELECT
  afs.ad_id,
  afs.launch_date,
  lw.launch_ctr_baseline,
  lw.launch_impressions,
  r7.rolling_7d_ctr,
  r7.rolling_7d_cpl,
  r3.rolling_3d_ctr,
  r3.current_frequency
FROM ad_first_seen afs
LEFT JOIN launch_window lw ON lw.ad_id = afs.ad_id
LEFT JOIN rolling_7d   r7 ON r7.ad_id = afs.ad_id
LEFT JOIN rolling_3d   r3 ON r3.ad_id = afs.ad_id;

COMMENT ON VIEW ads_switchable.v_ad_baselines IS
  'Per-ad rolling baselines for fatigue (P1.2) and CPL anomaly (P2.2) detection. launch_ctr_baseline is the average CTR across the first 7 days post-launch; rolling_7d_* is the 7-day window excluding today (partial ingest); rolling_3d_* is the 3-day window including the most recent day. Consumed by iris-daily-flags Edge Function (stage 2). Migration 0058 (stage 1c).';

-- Grants
GRANT SELECT ON ads_switchable.v_ad_baselines TO authenticated;
GRANT SELECT ON ads_switchable.v_ad_baselines TO iris_writer;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- REVOKE SELECT ON ads_switchable.v_ad_baselines FROM iris_writer;
-- REVOKE SELECT ON ads_switchable.v_ad_baselines FROM authenticated;
-- DROP VIEW ads_switchable.v_ad_baselines;
-- COMMIT;
