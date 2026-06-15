-- Migration 0210 — let providers see their routed private-pay leads in the portal
-- Date: 2026-06-15
-- Author: Claude (Sasha session) with owner review
-- Reason: Private-pay (self-funded) leads carry is_dq=true (they failed funding)
--   but route to the provider as a paying enrolment. The provider_read_submissions
--   RLS policy gated on `is_dq IS NOT TRUE`, so a routed private-pay learner was
--   invisible in the provider portal even though the lead was delivered. Found
--   live: Saranya Krishnan routed to Enterprise Made Simple 2026-06-15, absent
--   from EMS's portal. Widen the policy to also admit pay_route='private'.
--   Mirrors the same private-pay carve-out already applied in routing
--   (_shared/route-lead.ts, netlify-lead-router) and admin display.
-- Related: platform/docs/changelog.md 2026-06-15 (private-pay auto-route entry)
-- Impact: read-only widening of provider visibility. Only affects rows where
--   primary_routed_to already matches the provider AND pay_route='private'.
--   No other consumer reads through this policy (analytics uses its own
--   true-qual policy; admin uses admin.is_admin()). No data migration.
-- Rollback: re-narrow to `is_dq IS NOT TRUE` (DOWN below). Safe, additive.

-- UP
ALTER POLICY provider_read_submissions ON leads.submissions
  USING (
    (primary_routed_to = crm.provider_user_provider_id())
    AND (is_dq IS NOT TRUE OR pay_route = 'private')
  );

-- DOWN
-- ALTER POLICY provider_read_submissions ON leads.submissions
--   USING (
--     (primary_routed_to = crm.provider_user_provider_id())
--     AND (is_dq IS NOT TRUE)
--   );
