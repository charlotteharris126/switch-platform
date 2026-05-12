-- Migration 0136 — exclude is_dq=true rows from provider-facing dashboard views
-- Date:   2026-05-12
-- Author: Claude (Sasha) with owner review
-- Reason:
--   Today's Riverside test session (6 employer-lead submissions, all flagged
--   is_dq=true with dq_reason='owner_test') exposed that the provider dashboard
--   views were counting test rows in the "leads routed" tiles. The Edge
--   Function routes every well-formed submission (no test-mode short-circuit
--   beyond TEST_MODE redirecting the U2 email), so any submission that lands
--   in leads.submissions also lands in leads.routing_log + crm.enrolments
--   regardless of whether it's a real lead or owner test.
--
--   Current owner workflow is to flag tests retroactively via /admin/leads
--   (sets is_dq=true, dq_reason='owner_test*'). The views ignore that flag,
--   so the only way tests stay out of dashboards today is if someone also
--   sets archived_at — partial discipline.
--
--   Effect of this migration:
--     - Riverside dashboard "total_routed": 5 → 0 (5 test rows excluded)
--     - EMS "still_open": 58 → 55 (3 stale test enrolment rows excluded;
--       cleanup of those rows ships separately as data-ops 027)
--     - WYK, Courses Direct: unchanged (no tests on those providers)
--     - vw_provider_performance leads_30d / enrolments_30d: any future test
--       row stays out automatically
--
--   Cleaner long-term answer is a dedicated leads.submissions.is_test column
--   so is_dq stays semantically "failed business-fit" only. Deferred — that
--   needs a separate migration + backfill of existing dq_reason values.
--
-- Related:
--   - platform/supabase/data-ops/027_delete_stale_test_enrolments_2026_05_12.sql
--     (companion data-ops removes the 6 stale 'open' enrolment rows that the
--     provider portals read directly, so Jane/Andy stop seeing them)
--   - leads.vw_needs_status_update already filters is_dq=false (no change)
--   - public.vw_admin_health / public.vw_weekly_kpi intentionally NOT changed:
--     vw_weekly_kpi splits is_dq into qualified vs dq buckets (test rows
--     visible as dq_leads — semantically OK); vw_admin_health is the
--     admin-side firehose, not provider-facing.
--
-- Nature: view body change only. No column add/remove/reorder, so
-- CREATE OR REPLACE VIEW is safe and preserves existing GRANTs (readonly_analytics
-- + functions_writer SELECTs).

-- UP

-- vw_provider_performance: filter routing_log + enrolments through submissions.is_dq.
CREATE OR REPLACE VIEW crm.vw_provider_performance AS
WITH windowed AS (
  SELECT
    p.provider_id,
    p.company_name,
    (
      SELECT count(*)::integer
      FROM leads.routing_log rl
      JOIN leads.submissions s ON s.id = rl.submission_id
      WHERE rl.provider_id = p.provider_id
        AND rl.routed_at > (now() - '30 days'::interval)
        AND s.is_dq IS NOT TRUE
    ) AS leads_30d,
    (
      SELECT count(*)::integer
      FROM crm.enrolments e
      JOIN leads.submissions s ON s.id = e.submission_id
      WHERE e.provider_id = p.provider_id
        AND e.status = ANY (ARRAY['enrolled'::text, 'signed'::text])
        AND e.status_updated_at > (now() - '30 days'::interval)
        AND s.is_dq IS NOT TRUE
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

-- vw_provider_billing_state: filter both CTEs.
--   - counts: LEFT JOIN through submissions and exclude is_dq=true enrolments
--   - routing: add is_dq IS NOT TRUE to the WHERE
CREATE OR REPLACE VIEW crm.vw_provider_billing_state AS
WITH counts AS (
  SELECT
    p.provider_id,
    p.company_name,
    p.active,
    p.pilot_status,
    p.pricing_model,
    p.free_enrolments_remaining AS free_enrolments_cap,
    count(e.id) AS total_enrolment_rows,
    count(*) FILTER (WHERE e.status = 'enrolled') AS confirmed_enrolled,
    count(*) FILTER (WHERE e.status = 'presumed_enrolled') AS presumed_enrolled,
    count(*) FILTER (WHERE e.status = 'cannot_reach') AS cannot_reach,
    count(*) FILTER (WHERE e.status = 'lost') AS lost,
    count(*) FILTER (WHERE e.status = 'open') AS still_open,
    count(*) FILTER (WHERE e.disputed_at IS NOT NULL) AS disputed,
    count(*) FILTER (WHERE e.status = ANY (ARRAY[
      'enrolled', 'presumed_enrolled',
      'signed', 'presumed_employer_signed'
    ])) AS billable_or_pending_count
  FROM crm.providers p
  LEFT JOIN crm.enrolments e
         ON e.provider_id = p.provider_id
  LEFT JOIN leads.submissions s
         ON s.id = e.submission_id
        AND s.is_dq IS NOT TRUE
  -- Only count enrolments whose underlying submission is non-test/non-DQ.
  -- LEFT JOIN + this WHERE means: if e.id IS NULL (no enrolments at all for
  -- the provider) we still get a row of zeros; if e.id IS NOT NULL but
  -- s.id IS NULL (the join filtered the submission out), the enrolment is
  -- excluded from all the count() FILTERs because the implicit NULL s.id
  -- means we treat that enrolment as not-present.
  WHERE e.id IS NULL OR s.id IS NOT NULL
  GROUP BY p.provider_id, p.company_name, p.active, p.pilot_status, p.pricing_model, p.free_enrolments_remaining
),
routing AS (
  SELECT
    submissions.primary_routed_to AS provider_id,
    count(DISTINCT lower(TRIM(BOTH FROM submissions.email))) AS total_routed
  FROM leads.submissions
  WHERE submissions.primary_routed_to IS NOT NULL
    AND submissions.archived_at IS NULL
    AND submissions.is_dq IS NOT TRUE
    AND submissions.email IS NOT NULL
    AND TRIM(BOTH FROM submissions.email) <> ''
  GROUP BY submissions.primary_routed_to
)
SELECT
  c.provider_id,
  c.company_name,
  c.active,
  c.pilot_status,
  c.pricing_model,
  COALESCE(r.total_routed, 0::bigint) AS total_routed,
  c.confirmed_enrolled,
  c.presumed_enrolled,
  c.cannot_reach,
  c.lost,
  c.still_open,
  c.disputed,
  c.billable_or_pending_count,
  LEAST(c.free_enrolments_cap::bigint, c.billable_or_pending_count) AS free_enrolments_used,
  GREATEST(0::bigint, c.free_enrolments_cap::bigint - c.billable_or_pending_count) AS free_enrolments_remaining,
  GREATEST(0::bigint, c.billable_or_pending_count - c.free_enrolments_cap::bigint) AS billable_count,
  CASE
    WHEN COALESCE(r.total_routed, 0::bigint) > 0
      THEN round(100.0 * c.billable_or_pending_count::numeric / r.total_routed::numeric, 1)
    ELSE NULL::numeric
  END AS conversion_rate_pct,
  c.free_enrolments_cap::bigint AS free_enrolments_cap
FROM counts c
LEFT JOIN routing r ON r.provider_id = c.provider_id;

-- DOWN
-- Re-run migration 0135 to restore vw_provider_billing_state (last definition before this change).
-- Re-run migration 0132 / earlier baseline for vw_provider_performance (no migration since baseline).
