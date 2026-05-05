-- Migration 0071 — revert migration 0070 (is_test flag)
-- Date: 2026-05-05
-- Author: Claude (session) with owner review
-- Reason: The is_test column introduced in 0070 was wrong. The existing
--   mechanism for owner/test submissions is is_dq=true with
--   dq_reason='owner_test_submission' and archived_at set. That pattern
--   fully closes the lead out of routing, Brevo, and all views. A
--   parallel is_test flag is redundant and leaves leads in an ambiguous
--   open state. Reverting cleanly.

BEGIN;

-- Restore original views (remove the WHERE NOT is_test filters added in 0070)

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
 AND m.date = DATE(s.submitted_at);

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
  AND s.routed_at < now() - INTERVAL '14 days'
  AND NOT EXISTS (
    SELECT 1 FROM crm.enrolments e
    WHERE e.submission_id = s.id
      AND e.status IN ('enrolled', 'not_enrolled', 'disputed', 'presumed_enrolled')
  )
ORDER BY s.routed_at ASC;

CREATE OR REPLACE VIEW public.vw_admin_health
  WITH (security_invoker = true) AS
SELECT
  (SELECT COUNT(*)::int FROM leads.submissions
    WHERE submitted_at > now() - INTERVAL '7 days')                                                  AS leads_last_7d,
  (SELECT COUNT(*)::int FROM leads.submissions
    WHERE primary_routed_to IS NULL AND is_dq = false
      AND submitted_at < now() - INTERVAL '48 hours')                                                AS unrouted_over_48h,
  (SELECT COUNT(*)::int FROM leads.dead_letter
    WHERE replayed_at IS NULL AND received_at < now() - INTERVAL '7 days')                          AS errors_over_7d,
  (SELECT COUNT(*)::int FROM leads.dead_letter WHERE replayed_at IS NULL)                           AS errors_unresolved_total,
  (SELECT COUNT(*)::int FROM leads.vw_needs_status_update)                                          AS needs_status_update_count;

-- Drop the column and associated objects
DROP POLICY IF EXISTS admin_update_submissions_is_test ON leads.submissions;
REVOKE UPDATE (is_test) ON leads.submissions FROM authenticated;
DROP INDEX IF EXISTS leads.leads_submissions_is_test_idx;
ALTER TABLE leads.submissions DROP COLUMN IF EXISTS is_test;

COMMIT;