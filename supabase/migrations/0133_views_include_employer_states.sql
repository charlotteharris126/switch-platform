-- Migration 0133 — extend two more views to handle employer statuses + per-provider flip days
-- Date: 2026-05-12
-- Author: Claude (Sasha)
-- Reason:
--   Companion to migration 0132 (which fixed vw_provider_billing_state).
--   The audit found two more views still using learner-only filters
--   that would silently misreport for Riverside / future B2B providers:
--
--     1. crm.vw_provider_performance — used by Iris's daily flags + the
--        auto-routing scoring algorithm (when it ships). Counts only
--        learner 'enrolled' status in the 30-day window, so Riverside's
--        enrolment_rate_30d would be permanently 0%. Extended to include
--        the employer 'signed' state too.
--
--     2. leads.vw_needs_status_update — finds leads routed >N days ago
--        with no terminal outcome. Two issues fixed:
--        a) The N-day threshold was hardcoded to 14. Now per-provider
--           via crm.providers.sla_presumed_flip_days.
--        b) The "lead has been actioned" exclusion list was learner-only
--           AND incomplete (missing lost, cannot_reach, engaged,
--           in_progress, signed, not_signed, presumed_employer_signed,
--           plus the attempt counter states). Replaced with a cleaner
--           "include leads where enrolment is null or status='open'".
--
-- Impact assessment:
--   1. Change: CREATE OR REPLACE on two views. Same shape, same column
--      names. Values change only for B2B providers (where they were
--      wrong) and for any learner provider with non-14-day cap (where
--      they were always wrong by the old hardcode).
--   2. Readers: Iris's flags cron, admin pages that show conversion
--      rate per provider, auto-routing scoring (once it ships).
--   3. Rollback: replace both views with the original bodies.
--   4. Sign-off: owner pending.

BEGIN;

CREATE OR REPLACE VIEW crm.vw_provider_performance AS
WITH windowed AS (
  SELECT
    p.provider_id,
    p.company_name,
    (
      SELECT count(*)::integer
      FROM leads.routing_log rl
      WHERE rl.provider_id = p.provider_id
        AND rl.routed_at > (now() - '30 days'::interval)
    ) AS leads_30d,
    (
      -- Count both learner 'enrolled' AND employer 'signed' as a
      -- successful enrolment. presumed_* states deliberately excluded
      -- so the 30-day enrolment-rate KPI doesn't get inflated by auto-
      -- flipped leads that haven't been confirmed.
      SELECT count(*)::integer
      FROM crm.enrolments e
      WHERE e.provider_id = p.provider_id
        AND e.status IN ('enrolled', 'signed')
        AND e.status_updated_at > (now() - '30 days'::interval)
    ) AS enrolments_30d
  FROM crm.providers p
  WHERE p.active = true AND p.archived_at IS NULL
)
SELECT
  provider_id,
  company_name,
  leads_30d,
  enrolments_30d,
  CASE
    WHEN leads_30d = 0 THEN NULL::numeric
    ELSE round(enrolments_30d::numeric / leads_30d::numeric, 4)
  END AS enrolment_rate_30d
FROM windowed;

CREATE OR REPLACE VIEW leads.vw_needs_status_update AS
SELECT
  s.id AS submission_id,
  s.primary_routed_to AS provider_id,
  s.first_name,
  s.last_name,
  s.email,
  s.course_id,
  s.routed_at,
  now() - s.routed_at AS routed_age,
  p.company_name AS provider_name
FROM leads.submissions s
LEFT JOIN crm.providers p ON p.provider_id = s.primary_routed_to
LEFT JOIN crm.enrolments e ON e.submission_id = s.id AND e.provider_id = s.primary_routed_to
WHERE s.primary_routed_to IS NOT NULL
  AND s.is_dq = false
  AND s.archived_at IS NULL
  -- Threshold sourced from each provider's SLA cap (migration 0127).
  -- v1 funded = 14 days, v2 employer = 60, CD currently 17 as grace.
  AND s.routed_at < (now() - (COALESCE(p.sla_presumed_flip_days, 14) || ' days')::interval)
  -- Lead has not been actioned: no enrolment row yet, OR enrolment
  -- is still at 'open'. Any non-open status means the provider
  -- engaged in some way (attempt_X, engaged, in_progress, signed,
  -- not_signed, enrolled, lost, cannot_reach, presumed_*) and is
  -- therefore NOT in need of a status update.
  AND (e.id IS NULL OR e.status = 'open')
ORDER BY s.routed_at;

COMMIT;
