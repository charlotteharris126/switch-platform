-- Migration 0135 — expose free_enrolments_cap on crm.vw_provider_billing_state
-- Date: 2026-05-12
-- Author: Claude (Sasha) with owner review
-- Reason: Migration 0132 moved the billing view to per-provider caps sourced
--         from crm.providers.free_enrolments_remaining, but the admin UI was
--         still hardcoding "/ 3" as the denominator on the providers table
--         and the home scoreboard. Result: Riverside (apprenticeship pilot,
--         PPA v2, 1 free Employer Signed) showed "1 / 3" instead of "1 / 1".
--
--         The cap was already present in the view's `counts` CTE
--         (`free_enrolments_cap`) but not exposed in the outer SELECT. This
--         migration just surfaces it. Backwards-compatible: existing
--         consumers select named columns; the additional column is harmless.
--
-- Related:
--   - platform/app/app/admin/providers/page.tsx (UI updated to read free_enrolments_cap)
--   - platform/app/app/admin/page.tsx (UI updated to read free_enrolments_cap)
--   - platform/docs/changelog.md (session addendum entry)
--
-- Nature: additive view column. No table change, no RLS change, no data
-- migration. Existing dashboards / Metabase queries continue to work
-- unchanged.

-- UP
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
  LEFT JOIN crm.enrolments e ON e.provider_id = p.provider_id
  GROUP BY p.provider_id, p.company_name, p.active, p.pilot_status, p.pricing_model, p.free_enrolments_remaining
),
routing AS (
  SELECT
    submissions.primary_routed_to AS provider_id,
    count(DISTINCT lower(TRIM(BOTH FROM submissions.email))) AS total_routed
  FROM leads.submissions
  WHERE submissions.primary_routed_to IS NOT NULL
    AND submissions.archived_at IS NULL
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
  -- Appended at end of SELECT (post-conversion_rate_pct) so CREATE OR REPLACE
  -- VIEW doesn't reorder existing columns — Postgres rejects column reorders
  -- via CREATE OR REPLACE; only trailing additions are allowed.
  c.free_enrolments_cap::bigint AS free_enrolments_cap
FROM counts c
LEFT JOIN routing r ON r.provider_id = c.provider_id;

-- DOWN
-- CREATE OR REPLACE VIEW crm.vw_provider_billing_state AS (... prior definition from migration 0132 ...)
-- Safe to rollback by re-running migration 0132's view definition.
