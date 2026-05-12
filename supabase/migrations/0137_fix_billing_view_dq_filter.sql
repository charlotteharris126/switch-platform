-- Migration 0137 — fix vw_provider_billing_state so providers with only-test
--                   enrolments still appear (with zero counts) instead of
--                   disappearing entirely.
-- Date:   2026-05-12
-- Author: Claude (Sasha) with owner review
-- Reason:
--   Migration 0136 added a JOIN through leads.submissions plus a top-level
--   WHERE clause to exclude is_dq=true rows from the counts CTE. That broke
--   the "provider has zero qualifying enrolments" case: when every enrolment
--   for a provider is a test, all rows in the join get filtered by WHERE,
--   the LEFT JOIN no longer protects the provider row, and GROUP BY
--   produces NO row for that provider. Result observed immediately after
--   shipping 0136: Riverside (3 test enrolments, 0 real) vanished from
--   crm.vw_provider_billing_state entirely, and any admin tile reading the
--   view sees nothing instead of zeros.
--
--   Correct shape: keep the LEFT JOINs unfiltered (so every provider row
--   survives), but push the is_dq filter INTO the count(*) FILTER clauses.
--   Test enrolments stop contributing to any count, but the provider row
--   still emerges with zeros across the board.
--
--   This is the same pattern used by the original baseline view — counts
--   are tracked per status with FILTER (WHERE ...) — just extended to also
--   require the underlying submission to be non-DQ.
--
-- Related:
--   - Migration 0136 introduced the issue
--   - vw_provider_performance was implemented as scalar subqueries (one per
--     provider), so it already returns 0 instead of disappearing — no fix
--     needed there.
--
-- Nature: view body change only. No column change, so CREATE OR REPLACE
-- VIEW preserves GRANTs. Backwards-compatible output for every provider
-- that previously appeared correctly.

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
    count(*) FILTER (WHERE e.id IS NOT NULL AND s.is_dq IS NOT TRUE) AS total_enrolment_rows,
    count(*) FILTER (WHERE e.status = 'enrolled' AND s.is_dq IS NOT TRUE) AS confirmed_enrolled,
    count(*) FILTER (WHERE e.status = 'presumed_enrolled' AND s.is_dq IS NOT TRUE) AS presumed_enrolled,
    count(*) FILTER (WHERE e.status = 'cannot_reach' AND s.is_dq IS NOT TRUE) AS cannot_reach,
    count(*) FILTER (WHERE e.status = 'lost' AND s.is_dq IS NOT TRUE) AS lost,
    count(*) FILTER (WHERE e.status = 'open' AND s.is_dq IS NOT TRUE) AS still_open,
    count(*) FILTER (WHERE e.disputed_at IS NOT NULL AND s.is_dq IS NOT TRUE) AS disputed,
    count(*) FILTER (WHERE e.status = ANY (ARRAY[
      'enrolled', 'presumed_enrolled',
      'signed', 'presumed_employer_signed'
    ]) AND s.is_dq IS NOT TRUE) AS billable_or_pending_count
  FROM crm.providers p
  LEFT JOIN crm.enrolments e ON e.provider_id = p.provider_id
  LEFT JOIN leads.submissions s ON s.id = e.submission_id
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
-- Re-run migration 0136 to restore the broken filter shape. Not recommended.
