-- Data-ops 046 — Backfill experiment metadata on submission 521 (Sycamore homes)
-- Date:   2026-05-23
-- Author: Claude (Mable session, cross-project to platform) with owner sign-off
-- Reason:
--   Submission 521 (Sycamore homes, page_url=/business/construction/, submitted
--   2026-05-23 14:56:45.765 UTC) landed with NULL experiment_id and
--   experiment_variant. Root cause: the business form template was missing the
--   experiment hidden inputs until commit 39807c6 (Mable, same session) — same
--   regression pattern as 2026-05-20's funded-form fix. Sycamore's submission
--   pre-dates that deploy by a few hours.
--
--   Attribution method: timing-based inference, NOT measurement.
--     - ads_switchable.page_views around the submission window (UTC):
--         14:34:45.424  variant B  (id 9780) — 22min before submit
--         14:53:51.539  variant B  (id 9783) — 2min 54sec before submit
--         12:36:28.686  variant A  (last A view, 2h 20min before submit)
--     - Sycamore's submission at 14:56:45 sits 2:54 after the 14:53:51 B view.
--       That's textbook landing → fill → submit timing for a paid social lead.
--     - No A views in the hour either side of the submission.
--     - Today's overall split skewed B (11 B vs 4 A views), well within
--       variance for a 15-view sample but consistent with the inference.
--
--   Not a random fill (cf. data-ops 045). The page_views evidence is strong
--   enough to call. Audit row records this as inferred so the dataset never
--   reads it as ground truth.
--
-- Idempotency: WHERE clause requires experiment_id IS NULL on submission 521,
-- so re-running is a no-op once applied.
--
-- Related:
--   commit 39807c6 (switchable site — business form hidden inputs fix)
--   commit fc1ace9 (platform — migration 0159 + admin/experiments RPC swap)
--   data-ops 045 (precedent — funded-form historical backfill, random method)
--
-- Audit: a system audit row written via audit.log_system_action with
-- attribution_method=timing_window_inference and attribution_is_exact=false.

BEGIN;

WITH updated AS (
  UPDATE leads.submissions
     SET experiment_id      = 'construction-hero-deputy-2026-05',
         experiment_variant = 'b',
         updated_at         = now()
   WHERE id = 521
     AND experiment_id IS NULL
  RETURNING id, page_url, created_at
)
SELECT audit.log_system_action(
  'system:data-ops:046',
  'experiment_id_inferred_backfill',
  'leads.submissions',
  '521',
  jsonb_build_object('experiment_id', NULL, 'experiment_variant', NULL),
  jsonb_build_object('experiment_id', 'construction-hero-deputy-2026-05', 'experiment_variant', 'b'),
  jsonb_build_object(
    'reason',                       'site-side hidden-field gap on business form (fixed in commit 39807c6 same session)',
    'attribution_method',           'timing_window_inference',
    'attribution_is_exact',         false,
    'rows_updated',                 (SELECT COUNT(*) FROM updated),
    'nearest_view_id',              9783,
    'nearest_view_variant',         'b',
    'nearest_view_seconds_before',  174,
    'last_a_view_seconds_before',   8417,
    'submitted_at',                 '2026-05-23T14:56:45.765Z',
    'lead_type',                    'employer_apprenticeship',
    'lead_company',                 'Sycamore homes'
  )
);

COMMIT;

-- =============================================================================
-- DOWN (manual)
-- =============================================================================
-- BEGIN;
-- UPDATE leads.submissions
--    SET experiment_id = NULL, experiment_variant = NULL, updated_at = now()
--  WHERE id = 521;
-- COMMIT;
