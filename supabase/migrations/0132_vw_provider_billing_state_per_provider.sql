-- Migration 0132 — rewrite vw_provider_billing_state for per-provider free cap + employer states
-- Date: 2026-05-12
-- Author: Claude (Sasha)
-- Reason:
--   Two bugs in the existing view, surfaced when Charlotte spotted
--   Riverside displaying "3/3 free" on the admin providers list:
--
--   1. The free-enrolment cap was hardcoded to 3 across all providers.
--      PPA v1 providers (EMS / CD / WYK) get the first 3 enrolments free
--      per the pilot terms; PPA v2 (Riverside) only gets the first 1 free
--      per clause 3.4c. The `free_enrolments_remaining` column on
--      crm.providers carries each provider's actual cap (3 or 1) but
--      the view ignored it.
--
--   2. The "billable or pending" count only matched learner statuses
--      (enrolled / presumed_enrolled). Employer leads that flip to
--      'signed' or 'presumed_employer_signed' should count too, since
--      they trigger billing the same way.
--
--   Rewrite uses crm.providers.free_enrolments_remaining as the
--   per-provider cap (read as "initial cap, never decremented") and
--   extends the billable filter to cover both learner and employer
--   success states.
--
-- Impact assessment:
--   1. Change: CREATE OR REPLACE on the view. Same column shape; only
--      the values change for any provider with a non-3 cap.
--   2. Readers: /admin/providers list page (col 158-159), any other
--      consumer of free_enrolments_used / free_enrolments_remaining.
--   3. Writers: view is read-only.
--   4. Rollback: replace with the original body (hardcoded 3 cap,
--      learner-only count).
--   5. Sign-off: owner pending.

BEGIN;

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
    -- Billable / pending = any success state across both lead types.
    -- learner: enrolled / presumed_enrolled
    -- employer: signed / presumed_employer_signed
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
  -- Per-provider free-cap math. Cap sourced from crm.providers.free_enrolments_remaining
  -- (semantically: the initial free-enrolment allocation under their PPA).
  LEAST(c.free_enrolments_cap::bigint, c.billable_or_pending_count) AS free_enrolments_used,
  GREATEST(0::bigint, c.free_enrolments_cap::bigint - c.billable_or_pending_count) AS free_enrolments_remaining,
  GREATEST(0::bigint, c.billable_or_pending_count - c.free_enrolments_cap::bigint) AS billable_count,
  CASE
    WHEN COALESCE(r.total_routed, 0::bigint) > 0
      THEN round(100.0 * c.billable_or_pending_count::numeric / r.total_routed::numeric, 1)
    ELSE NULL::numeric
  END AS conversion_rate_pct
FROM counts c
LEFT JOIN routing r ON r.provider_id = c.provider_id;

COMMIT;
