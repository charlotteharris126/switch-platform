-- Migration 0017 — Add funding_category to leads.submissions and leads.partials
-- Date: 2026-04-25
-- Author: Claude (platform Session D opening) with owner review
-- Reason: Today the `funding_route` column holds a mix of category-ish values
--         (`'self'`) and specific scheme names (`'free_courses_for_jobs'`,
--         `'lift_futures'`). The dashboard filter is unreadable and reporting
--         (Session I) needs a clean top-level category split.
--
--         Adds `funding_category` (`gov` / `self` / `loan`) as a top-level
--         enum-like column. Keeps `funding_route` for the specific scheme
--         name (FCFJ, Skills Bootcamp, etc.). Backfills existing rows so
--         no historical data is lost.
--
--         Schema-versioning impact: payload schema bump 1.0 → 1.1
--         (in switchable/site/docs/funded-funnel-architecture.md).
--
-- Related: platform/docs/admin-dashboard-scoping.md § Session D,
--          .claude/rules/schema-versioning.md (additive change + minor bump),
--          switchable/site/docs/funded-funnel-architecture.md (payload schema).

-- UP

-- =============================================================================
-- 1. Add funding_category column to leads.submissions
-- =============================================================================
-- Additive, nullable. Backfilled below from existing funding_route values so
-- historical rows are categorised consistently with new submissions.

ALTER TABLE leads.submissions
  ADD COLUMN IF NOT EXISTS funding_category TEXT;

COMMENT ON COLUMN leads.submissions.funding_category IS
  'Top-level funding category: gov | self | loan. Set from the form payload at ingest time. funding_route holds the specific scheme name (e.g. free_courses_for_jobs, lift_futures, skills_bootcamp). Added migration 0017.';

-- =============================================================================
-- 2. Add funding_category column to leads.partials
-- =============================================================================
-- Mirrors leads.submissions for funnel parity. Partials track the same shape
-- so funnel analysis can join on funding_category cleanly.

ALTER TABLE leads.partials
  ADD COLUMN IF NOT EXISTS funding_category TEXT;

COMMENT ON COLUMN leads.partials.funding_category IS
  'Top-level funding category: gov | self | loan. Mirrors leads.submissions.funding_category for funnel parity. Added migration 0017.';

-- =============================================================================
-- 3. Backfill leads.submissions historical rows
-- =============================================================================
-- Mapping (based on values observed in production as of 2026-04-25):
--   'self'                    → category = self,  route stays 'self' for now
--                               (no specific scheme, owner decision: leave as-is
--                               until self-funded scheme names exist)
--   'free_courses_for_jobs'   → category = gov,   route stays
--   'lift_futures'            → category = gov,   route stays
--   'switchable-funded'       → category = gov,   route stays (legacy form-shape value)
--   'switchable-self-funded'  → category = self,  route stays (legacy form-shape value)
--   anything else / NULL      → leave NULL, flag in changelog

UPDATE leads.submissions
SET funding_category = CASE
  WHEN funding_route IN ('free_courses_for_jobs', 'lift_futures', 'skills_bootcamp', 'aeb', 'switchable-funded') THEN 'gov'
  WHEN funding_route IN ('self', 'switchable-self-funded') THEN 'self'
  WHEN funding_route IN ('loan', 'all', 'switchable-loan') THEN 'loan'
  ELSE NULL
END
WHERE funding_category IS NULL;

-- =============================================================================
-- 4. Backfill leads.partials historical rows
-- =============================================================================

UPDATE leads.partials
SET funding_category = CASE
  WHEN funding_route IN ('free_courses_for_jobs', 'lift_futures', 'skills_bootcamp', 'aeb', 'switchable-funded') THEN 'gov'
  WHEN funding_route IN ('self', 'switchable-self-funded') THEN 'self'
  WHEN funding_route IN ('loan', 'all', 'switchable-loan') THEN 'loan'
  ELSE NULL
END
WHERE funding_category IS NULL;

-- =============================================================================
-- 5. Indexes for dashboard filtering and reporting
-- =============================================================================

CREATE INDEX IF NOT EXISTS submissions_funding_category_idx
  ON leads.submissions (funding_category, submitted_at DESC);

CREATE INDEX IF NOT EXISTS partials_funding_category_idx
  ON leads.partials (funding_category);

-- DOWN
-- DROP INDEX IF EXISTS leads.partials_funding_category_idx;
-- DROP INDEX IF EXISTS leads.submissions_funding_category_idx;
-- ALTER TABLE leads.partials DROP COLUMN IF EXISTS funding_category;
-- ALTER TABLE leads.submissions DROP COLUMN IF EXISTS funding_category;
