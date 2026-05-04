-- Migration 0068 — ads_switchable.page_views: experiment page view logging
-- Date: 2026-05-04
-- Author: Claude (platform session) with owner review
-- Reason: Track per-variant page view counts for A/B experiment analysis.
--   The variant-router Netlify Edge Function fires a fire-and-forget POST to
--   the log-page-view Supabase Edge Function on every experiment page load.
--   Gives empirical 50/50 split verification and view-to-lead conversion rate
--   per variant. No PII — slug + variant + timestamp only.
-- Related: platform/supabase/functions/log-page-view/index.ts,
--   switchable/site/deploy/netlify/edge-functions/variant-router.ts,
--   platform/app/app/admin/experiments/page.tsx
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. New table: ads_switchable.page_views. No existing table modified.
--   2. Readers: /admin/experiments page (supabase-js, authenticated admin),
--      readonly_analytics role (Iris, Mira, Metabase). No existing query
--      references this table — pure addition.
--   3. Writers: log-page-view Edge Function (SUPABASE_DB_URL superuser,
--      drops to functions_writer via SET LOCAL ROLE).
--   4. Schema version: additive new table. No payload schema change. No bump.
--   5. Data migration: none. Historical experiments have no view data.
--   6. Roles: functions_writer granted INSERT; readonly_analytics and
--      authenticated admin granted SELECT via RLS policies below.
--   7. Rollback: DROP TABLE in DOWN. Safe to run at any point; rows are
--      analytics-only with no FK deps.
--   8. Sign-off: owner (session 2026-05-04).
-- =============================================================================

BEGIN;

CREATE TABLE ads_switchable.page_views (
  id            BIGSERIAL     PRIMARY KEY,
  experiment_id TEXT          NOT NULL,
  page_slug     TEXT          NOT NULL,
  variant       TEXT          NOT NULL CHECK (variant IN ('a', 'b')),
  viewed_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE ads_switchable.page_views IS
  'One row per experiment page load, logged server-side from the Netlify '
  'variant-router Edge Function via the log-page-view Supabase Edge Function. '
  'No PII — experiment_id + page_slug + variant + timestamp only. '
  'Primary use: verify 50/50 A/B split and compute view-to-qualified-lead '
  'conversion rate per variant in /admin/experiments. Migration 0068.';

COMMENT ON COLUMN ads_switchable.page_views.experiment_id IS
  'Matches experiments.json manifest id, e.g. "counselling-tees-hero-variant-2026-05".';

COMMENT ON COLUMN ads_switchable.page_views.page_slug IS
  'Slug portion of the page URL, e.g. "counselling-skills-tees-valley".';

COMMENT ON COLUMN ads_switchable.page_views.variant IS
  '"a" = canonical / control, "b" = challenger. Mirrors experiment_variant on leads.submissions.';

-- Composite index on (experiment_id, variant, viewed_at) covers the primary
-- query pattern: COUNT(*) GROUP BY variant WHERE experiment_id = X, with a
-- date range filter for trend views. viewed_at DESC serves last-N-days slices.
CREATE INDEX ads_switchable_page_views_exp_idx
  ON ads_switchable.page_views (experiment_id, variant, viewed_at DESC);

-- Row Level Security
ALTER TABLE ads_switchable.page_views ENABLE ROW LEVEL SECURITY;

-- Admin dashboard reads via supabase-js (authenticated Supabase user)
CREATE POLICY "admin_read_page_views"
  ON ads_switchable.page_views
  FOR SELECT TO authenticated
  USING (admin.is_admin());

-- Iris, Mira, Metabase — read-only analytics role
CREATE POLICY "readonly_analytics_read_page_views"
  ON ads_switchable.page_views
  FOR SELECT TO readonly_analytics
  USING (true);

-- log-page-view Edge Function writes via functions_writer role
GRANT INSERT ON ads_switchable.page_views TO functions_writer;
GRANT USAGE ON SEQUENCE ads_switchable.page_views_id_seq TO functions_writer;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- Safe to run at any point — table has no FK dependents and rows are
-- analytics-only. Drops the table, index, policies, and grants entirely.
--
-- BEGIN;
-- DROP TABLE IF EXISTS ads_switchable.page_views;
-- COMMIT;