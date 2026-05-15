-- Migration 0143 — provider RLS on leads.submissions excludes is_dq
-- Date:   2026-05-15
-- Author: Sasha (Charlotte's session)
-- Reason:
--   /provider/leads and /provider home both read leads.submissions
--   directly. The existing provider_read_submissions RLS policy scopes
--   by primary_routed_to but does NOT exclude is_dq=true rows. So
--   pre-launch test submissions flagged is_dq=true (per data-ops
--   030 / 031 / 034) still appear in the provider's portal view —
--   bit Charlotte twice on Riverside today.
--
--   Cleanest architectural fix: bake the is_dq exclusion into the
--   policy itself rather than patching every query. Now every
--   provider-facing read on leads.submissions naturally hides test
--   rows, and any future portal page added later inherits the rule
--   without needing to remember the filter.
--
--   This is consistent with migration 0136's pattern for dashboard
--   views (vw_provider_performance + vw_provider_billing_state both
--   filter is_dq IS NOT TRUE) — the policy now extends the same
--   discipline to the underlying-table reads.
--
--   The admin policy (admin_read_submissions) is unchanged — admins
--   still see test rows on /admin/leads etc. for audit and cleanup.
--   Analytics policy (analytics_read_submissions) is unchanged — the
--   readonly_analytics role used by Metabase + agent MCPs still sees
--   everything; downstream views remain responsible for filtering.
--
-- Impact:
--   - Riverside portal /provider/leads count: 16 → 0 immediately on apply.
--   - No effect on real (non-DQ) leads for any provider.
--   - No effect on admin views or agent MCP queries.

BEGIN;

DROP POLICY IF EXISTS provider_read_submissions ON leads.submissions;

CREATE POLICY provider_read_submissions
  ON leads.submissions
  FOR SELECT
  TO authenticated
  USING (
    primary_routed_to = crm.provider_user_provider_id()
    AND is_dq IS NOT TRUE
  );

COMMIT;

-- DOWN
-- DROP POLICY IF EXISTS provider_read_submissions ON leads.submissions;
-- CREATE POLICY provider_read_submissions
--   ON leads.submissions
--   FOR SELECT
--   TO authenticated
--   USING (primary_routed_to = crm.provider_user_provider_id());
