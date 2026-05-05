-- Migration 0070 — leads.submissions: add is_test flag
-- Date: 2026-05-05
-- Author: Claude (session) with owner review
-- Reason: Owner-submitted test leads (e.g. Charlotte Harris #277 from
--   registration form QA) must be flaggable so they are excluded from
--   KPI views, CPL calculations, and the "needs attention" panel. Without
--   this flag, test submissions inflate total_submissions, distort CPL,
--   and pollute the provider routing queue.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new nullable-false BOOLEAN column `is_test` on
--      `leads.submissions` (DEFAULT false — all existing rows get false,
--      which is correct: they are real leads). Sparse partial index on
--      `is_test = true` keeps the index tiny.
--   2. Readers affected: all views that count or filter submissions.
--      `public.vw_weekly_kpi`, `public.vw_admin_health`,
--      `leads.vw_needs_status_update`, and `public.vw_attribution` are
--      all replaced here to add `AND NOT is_test` (or equivalent) so
--      test submissions are silently excluded from metrics going forward.
--      `public.vw_funnel_dropoff` is not updated — it is a raw join used
--      for drop-off analysis; test session data is acceptable noise there.
--   3. Writers affected: none new. The admin dashboard gains a Server
--      Action to flip is_test in a future session; for now the flag is
--      set via the SQL editor on a per-row basis.
--   4. Schema version: additive optional field per
--      `.claude/rules/schema-versioning.md` — no payload version bump.
--   5. Data migration: none. All existing rows correctly land at
--      is_test = false.
--   6. Role/policy: GRANT UPDATE (is_test) to authenticated + new RLS
--      UPDATE policy gated on admin.is_admin(). Pattern mirrors
--      migration 0051 (admin_update_dead_letter).
--   7. Rollback: DROP COLUMN in DOWN. Safe before any test-tagged rows
--      exist in a consumer's cache. After tagging, dropping the column
--      removes the flag but leaves the rows (they stay as real leads in
--      all views until re-tagged).
--   8. Sign-off: owner (this session).
--
-- Related:
--   platform/docs/data-architecture.md (column + index + view updates)
--   platform/docs/changelog.md (entry at top)
-- =============================================================================

BEGIN;

-- 1. Column
ALTER TABLE leads.submissions
  ADD COLUMN is_test BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN leads.submissions.is_test IS
  'True when this submission was created by the owner for testing/QA purposes.
   Excluded from all KPI views, CPL calculations, and the routing queue.
   Migration 0070.';

-- 2. Sparse index (only test rows — expected to be < 1% of volume)
CREATE INDEX leads_submissions_is_test_idx
  ON leads.submissions (submitted_at DESC)
  WHERE is_test = true;

-- 3. Column-level privilege: allow authenticated (admin) to update is_test only
GRANT UPDATE (is_test) ON leads.submissions TO authenticated;

-- 4. RLS UPDATE policy gated on admin.is_admin()
CREATE POLICY admin_update_submissions_is_test
  ON leads.submissions
  FOR UPDATE
  TO authenticated
  USING (admin.is_admin())
  WITH CHECK (admin.is_admin());

-- 5. Replace views to exclude test submissions from metrics

-- 5a. public.vw_attribution — CPL calculations must not include test leads
CREATE OR REPLACE VIEW public.vw_attribution
  WITH (security_invoker = true) AS
SELECT
  s.id AS submission_id,
  s.submitted_at,
  s.course_id,
  s.primary_routed_to,
  s.utm_campaign,
  s.utm_content,
  m.date AS ad_date,
  m.campaign_id,
  m.campaign_name,
  m.ad_id,
  m.ad_name,
  m.spend AS ad_daily_spend,
  m.cost_per_lead AS ad_daily_cpl
FROM leads.submissions s
LEFT JOIN ads_switchable.meta_daily m
  ON m.ad_id = s.utm_content
 AND m.date = DATE(s.submitted_at)
WHERE NOT s.is_test;

-- 5b. public.vw_weekly_kpi — KPI scorecard excludes test submissions
CREATE OR REPLACE VIEW public.vw_weekly_kpi
  WITH (security_invoker = true) AS
WITH weekly_leads AS (
  SELECT
    date_trunc('week', submitted_at) AS week_start,
    COUNT(*) AS total_submissions,
    COUNT(*) FILTER (WHERE NOT is_dq) AS qualified_leads,
    COUNT(*) FILTER (WHERE is_dq) AS dq_leads,
    COUNT(DISTINCT primary_routed_to) FILTER (WHERE primary_routed_to IS NOT NULL) AS providers_served
  FROM leads.submissions
  WHERE NOT is_test
  GROUP BY 1
),
weekly_spend AS (
  SELECT
    date_trunc('week', date) AS week_start,
    SUM(spend) AS meta_spend
  FROM ads_switchable.meta_daily
  GROUP BY 1
),
weekly_enrolments AS (
  SELECT
    date_trunc('week', sent_to_provider_at) AS week_start,
    COUNT(*) AS enrolments_this_week
  FROM crm.enrolments
  WHERE status IN ('enrolled', 'presumed_enrolled', 'billed', 'paid')
  GROUP BY 1
)
SELECT
  wl.week_start,
  wl.total_submissions,
  wl.qualified_leads,
  wl.dq_leads,
  wl.providers_served,
  ws.meta_spend,
  we.enrolments_this_week
FROM weekly_leads wl
LEFT JOIN weekly_spend ws      USING (week_start)
LEFT JOIN weekly_enrolments we USING (week_start)
ORDER BY wl.week_start DESC;

-- 5c. leads.vw_needs_status_update — test leads must not appear in the routing queue
CREATE OR REPLACE VIEW leads.vw_needs_status_update
  WITH (security_invoker = true) AS
SELECT
  s.id                  AS submission_id,
  s.primary_routed_to   AS provider_id,
  s.first_name,
  s.last_name,
  s.email,
  s.course_id,
  s.routed_at,
  (now() - s.routed_at) AS routed_age,
  p.company_name        AS provider_name
FROM leads.submissions s
LEFT JOIN crm.providers p ON p.provider_id = s.primary_routed_to
WHERE s.primary_routed_to IS NOT NULL
  AND s.is_dq = false
  AND s.archived_at IS NULL
  AND s.is_test = false
  AND s.routed_at < now() - INTERVAL '14 days'
  AND NOT EXISTS (
    SELECT 1 FROM crm.enrolments e
    WHERE e.submission_id = s.id
      AND e.status IN ('enrolled', 'not_enrolled', 'disputed', 'presumed_enrolled')
  )
ORDER BY s.routed_at ASC;

-- 5d. public.vw_admin_health — headline counters exclude test submissions
CREATE OR REPLACE VIEW public.vw_admin_health
  WITH (security_invoker = true) AS
SELECT
  (SELECT COUNT(*)::int FROM leads.submissions
    WHERE submitted_at > now() - INTERVAL '7 days'
      AND NOT is_test)                                                                        AS leads_last_7d,
  (SELECT COUNT(*)::int FROM leads.submissions
    WHERE primary_routed_to IS NULL
      AND is_dq = false
      AND is_test = false
      AND submitted_at < now() - INTERVAL '48 hours')                                        AS unrouted_over_48h,
  (SELECT COUNT(*)::int FROM leads.dead_letter
    WHERE replayed_at IS NULL AND received_at < now() - INTERVAL '7 days')                  AS errors_over_7d,
  (SELECT COUNT(*)::int FROM leads.dead_letter WHERE replayed_at IS NULL)                   AS errors_unresolved_total,
  (SELECT COUNT(*)::int FROM leads.vw_needs_status_update)                                  AS needs_status_update_count;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP INDEX IF EXISTS leads.leads_submissions_is_test_idx;
-- DROP POLICY IF EXISTS admin_update_submissions_is_test ON leads.submissions;
-- REVOKE UPDATE (is_test) ON leads.submissions FROM authenticated;
-- ALTER TABLE leads.submissions DROP COLUMN is_test;
-- -- Restore original view definitions (from migration 0001 / 0016 body):
-- -- CREATE OR REPLACE VIEW public.vw_attribution ... (without WHERE NOT is_test)
-- -- CREATE OR REPLACE VIEW public.vw_weekly_kpi ... (without WHERE NOT is_test)
-- -- CREATE OR REPLACE VIEW leads.vw_needs_status_update ... (without AND is_test = false)
-- -- CREATE OR REPLACE VIEW public.vw_admin_health ... (without AND NOT is_test)
-- COMMIT;