-- Data-ops 045 — Backfill experiment_id / experiment_variant for historical
--                rows that landed before Mable's site-side fix (commit 574b2c5)
-- Date:   2026-05-20
-- Author: Sasha (Charlotte's session, push from Mable)
-- Reason:
--   The 7 funded-course DQ panel forms on template/funded-course.html were
--   missing experiment_id / experiment_variant hidden inputs until Mable's
--   commit 574b2c5 deployed. As a result, ~32 of 39 DQs + ~20 of 100
--   qualified submissions from the two Tees experiment pages landed in
--   leads.submissions with NULL experiment metadata, making the
--   /admin/experiments page DQ column unreadable.
--
--   This script back-fills the metadata so Charlotte can read the
--   experiments and make a decision.
--
--   Attribution method: 50/50 random assignment per row. Exact attribution
--   is impossible because:
--     - ads_switchable.page_views has no session_id column (aggregate by
--       design, migration 0068).
--     - The variant-router Edge Function sets a browser cookie
--       (exp_<id>=a|b) that's never recorded against the submission.
--     - leads.submissions.session_id exists but doesn't join to anything
--       carrying the cookie value.
--
--   The variant-router uses Math.random() < 0.5 on first visit, and the
--   live view splits are 1805/1780 (counselling) and 1653/1695 (smm) —
--   both within 0.5% of 50/50. Random fill is statistically valid for
--   aggregate DQ% comparison; not for individual-row attribution.
--
--   Out of scope (Mable's note, respected here):
--     - Submissions on the experiment page from BEFORE the experiment
--       started. Those legitimately have NULL because the page YAML didn't
--       carry the experiment: block yet.
--     - Re-application children (parent_submission_id IS NOT NULL).
--       Re-applications inherit the parent's metadata or none — backfill
--       targets fresh submissions only.
--
--   Experiment start dates (from Mable's note, BST):
--     counselling-tees-hero-variant-2026-05: 2026-05-04
--     smm-tees-hero-variant-2026-05:         2026-05-06
--
-- Idempotency: only touches rows where experiment_id IS NULL. Re-running
-- after Mable's site fix is a no-op (new submissions land with metadata).
--
-- Audit: a system audit row written at the end via audit.log_system_action
-- so the /admin audit view + Mira's Monday audit shows the backfill
-- happened and how many rows were touched.

BEGIN;

WITH counselling_backfill AS (
  UPDATE leads.submissions
     SET experiment_id      = 'counselling-tees-hero-variant-2026-05',
         experiment_variant = CASE WHEN random() < 0.5 THEN 'a' ELSE 'b' END,
         updated_at         = now()
   WHERE experiment_id IS NULL
     AND parent_submission_id IS NULL
     AND page_url LIKE '%/counselling-skills-tees-valley%'
     AND created_at >= '2026-05-04 00:00:00+01'
  RETURNING id, experiment_variant
),
smm_backfill AS (
  UPDATE leads.submissions
     SET experiment_id      = 'smm-tees-hero-variant-2026-05',
         experiment_variant = CASE WHEN random() < 0.5 THEN 'a' ELSE 'b' END,
         updated_at         = now()
   WHERE experiment_id IS NULL
     AND parent_submission_id IS NULL
     AND page_url LIKE '%/smm-for-ecommerce-tees-valley%'
     AND created_at >= '2026-05-06 00:00:00+01'
  RETURNING id, experiment_variant
),
totals AS (
  SELECT
    (SELECT COUNT(*) FROM counselling_backfill)                                   AS counselling_total,
    (SELECT COUNT(*) FILTER (WHERE experiment_variant = 'a') FROM counselling_backfill) AS counselling_a,
    (SELECT COUNT(*) FILTER (WHERE experiment_variant = 'b') FROM counselling_backfill) AS counselling_b,
    (SELECT COUNT(*) FROM smm_backfill)                                           AS smm_total,
    (SELECT COUNT(*) FILTER (WHERE experiment_variant = 'a') FROM smm_backfill)   AS smm_a,
    (SELECT COUNT(*) FILTER (WHERE experiment_variant = 'b') FROM smm_backfill)   AS smm_b
)
SELECT audit.log_system_action(
  'system:data-ops:045',
  'experiment_id_random_backfill',
  'leads.submissions',
  NULL,
  NULL,
  NULL,
  jsonb_build_object(
    'reason',                    'site-side hidden-field gap on funded-course DQ panel forms (Mable commit 574b2c5)',
    'attribution_method',        '50_50_random',
    'attribution_is_exact',      false,
    'aggregate_only',            true,
    'counselling_total',         t.counselling_total,
    'counselling_assigned_a',    t.counselling_a,
    'counselling_assigned_b',    t.counselling_b,
    'smm_total',                 t.smm_total,
    'smm_assigned_a',            t.smm_a,
    'smm_assigned_b',            t.smm_b
  )
)
FROM totals t;

COMMIT;

-- =============================================================================
-- DOWN (manual)
-- =============================================================================
-- Cannot perfectly reverse — random assignment is irrecoverable. Closest:
-- BEGIN;
-- UPDATE leads.submissions
--    SET experiment_id = NULL, experiment_variant = NULL, updated_at = now()
--  WHERE (page_url LIKE '%/counselling-skills-tees-valley%' AND created_at >= '2026-05-04 00:00:00+01')
--     OR (page_url LIKE '%/smm-for-ecommerce-tees-valley%'  AND created_at >= '2026-05-06 00:00:00+01')
--    -- WARNING: also clears post-fix metadata if not narrowed by updated_at.
-- COMMIT;
