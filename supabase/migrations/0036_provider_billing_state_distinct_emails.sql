-- Migration 0036: vw_provider_billing_state.total_routed redefined as distinct
--                  emails per provider (matches the global "unique people"
--                  KPI on /admin overview)
-- Date: 2026-04-27
-- Author: Claude (Session 14, post DQ-leak fix) with owner approval
-- Reason:
--   /admin overview "Routed" KPI is `COUNT(DISTINCT lower(trim(email)))`
--   across all live (non-archived) routed submissions: the unique humans we
--   have sent to a provider. Today that is 89.
--
--   `vw_provider_billing_state.total_routed` (migration 0035) defined the
--   per-provider count as `SELECT COUNT(*) FROM leads.routing_log GROUP BY
--   provider_id`. That counted EVERY routing-log row, including:
--     - archived test submissions (2 routing-log rows still in place)
--     - the Anita Bucpapaj orphan from data-ops/010 (correction left the
--       routing_log row behind for audit, but submissions.primary_routed_to
--       is now NULL so she should not count as routed)
--     - multi-routings of the same person (e.g. Glennis routed to EMS three
--       times for three different course re-applications)
--
--   Sum-by-provider therefore exceeded the overview KPI: 65 (EMS) + 17 (CD)
--   + 15 (WYK) = 97, vs 89 on the overview tile. Confusing for Charlotte
--   when she compares the two pages.
--
--   This migration redefines `total_routed` as
--     `SELECT COUNT(DISTINCT lower(trim(email))) FROM leads.submissions
--      WHERE primary_routed_to = <provider> AND archived_at IS NULL`.
--
--   Sum across providers will still slightly exceed the global KPI by the
--   number of people who have been sent to more than one provider (today,
--   Jade Millward overlaps EMS + Courses Direct: per-provider sums to 90;
--   global distinct = 89). That overlap is expected and visible on the
--   providers page.
--
--   Conversion rate uses the same denominator so is also corrected.
--
-- Related:
--   - migration 0035 (original view definition)
--   - data-ops/010 (Anita backfill that exposed the orphaned routing_log)
--   - platform/docs/changelog.md 2026-04-27 entries
--   - .claude/rules/business.md (lead matching, pilot pricing)

-- UP

CREATE OR REPLACE VIEW crm.vw_provider_billing_state
  WITH (security_invoker = true) AS
WITH counts AS (
  SELECT
    p.provider_id,
    p.company_name,
    p.active,
    p.pilot_status,
    p.pricing_model,
    COUNT(e.id)                                                      AS total_enrolment_rows,
    COUNT(*) FILTER (WHERE e.status = 'enrolled')                    AS confirmed_enrolled,
    COUNT(*) FILTER (WHERE e.status = 'presumed_enrolled')           AS presumed_enrolled,
    COUNT(*) FILTER (WHERE e.status = 'cannot_reach')                AS cannot_reach,
    COUNT(*) FILTER (WHERE e.status = 'lost')                        AS lost,
    COUNT(*) FILTER (WHERE e.status = 'open')                        AS still_open,
    COUNT(*) FILTER (WHERE e.disputed_at IS NOT NULL)                AS disputed,
    COUNT(*) FILTER (
      WHERE e.status IN ('enrolled', 'presumed_enrolled')
    ) AS billable_or_pending_count
  FROM crm.providers p
    LEFT JOIN crm.enrolments e ON e.provider_id = p.provider_id
   GROUP BY p.provider_id, p.company_name, p.active, p.pilot_status, p.pricing_model
),
routing AS (
  -- Distinct emails per provider, restricted to live (non-archived) submissions.
  -- Matches the overview KPI definition. Same person multi-routed to the same
  -- provider counts once. Archived test rows excluded. Orphaned routing_log
  -- entries (where primary_routed_to was nulled by a correction) excluded.
  SELECT
    primary_routed_to AS provider_id,
    COUNT(DISTINCT lower(trim(email))) AS total_routed
   FROM leads.submissions
  WHERE primary_routed_to IS NOT NULL
    AND archived_at IS NULL
    AND email IS NOT NULL
    AND trim(email) <> ''
  GROUP BY primary_routed_to
)
SELECT
  c.provider_id,
  c.company_name,
  c.active,
  c.pilot_status,
  c.pricing_model,
  COALESCE(r.total_routed, 0)                                         AS total_routed,
  c.confirmed_enrolled,
  c.presumed_enrolled,
  c.cannot_reach,
  c.lost,
  c.still_open,
  c.disputed,
  c.billable_or_pending_count,
  LEAST(3, c.billable_or_pending_count)                               AS free_enrolments_used,
  GREATEST(0, 3 - c.billable_or_pending_count)                        AS free_enrolments_remaining,
  GREATEST(0, c.billable_or_pending_count - 3)                        AS billable_count,
  CASE
    WHEN COALESCE(r.total_routed, 0) > 0
      THEN ROUND(100.0 * c.billable_or_pending_count / r.total_routed, 1)
    ELSE NULL
  END                                                                 AS conversion_rate_pct
  FROM counts c
  LEFT JOIN routing r ON r.provider_id = c.provider_id;

COMMENT ON VIEW crm.vw_provider_billing_state IS
  'Derived per-provider billing + conversion state. total_routed is distinct emails per provider across live (non-archived) submissions, matching the overview "Unique people routed" KPI. Sum-across-providers can slightly exceed the global KPI when a learner has been sent to more than one provider; that overlap is intentional and visible on the providers page.';

GRANT SELECT ON crm.vw_provider_billing_state TO authenticated;

-- DOWN
-- Reverts to migration 0035 definition (total_routed = COUNT(*) FROM
-- leads.routing_log GROUP BY provider_id).
