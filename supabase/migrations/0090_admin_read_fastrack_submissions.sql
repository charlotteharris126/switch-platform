-- Migration 0090 — Admin RLS read policy + grant for leads.fastrack_submissions
-- Date: 2026-05-07
-- Author: Claude (Bit / platform Session 34, evening)
-- Reason: Migration 0087 created leads.fastrack_submissions with RLS enabled
--   plus policies for `functions_writer` (ALL) and `readonly_analytics`
--   (SELECT). The `authenticated` role used by the admin dashboard
--   (app/app/admin/leads/[id]/page.tsx) had neither policy nor grant, so
--   the admin lead detail page's new fastrack card would render empty
--   even when a fastrack child row exists. This migration adds the
--   admin SELECT policy + table-level GRANT, mirroring the pattern in
--   migration 0014 for leads.submissions / leads.routing_log /
--   leads.dead_letter / leads.partials / leads.gateway_captures /
--   crm.providers / crm.enrolments / crm.disputes.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: additive only. One new SELECT-only policy + one
--      table-level GRANT on the `authenticated` role for one table.
--   2. Readers affected: admin lead detail page (will now display
--      fastrack data when the child row exists; previously rendered the
--      empty-card branch). No other reader changes.
--   3. Writers affected: none.
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role / policy: adds `admin_read_fastrack_submissions` policy +
--      table-level GRANT SELECT TO authenticated.
--   7. Rollback: DOWN drops the policy and revokes the grant.
--   8. Sign-off: owner (Session 34, 2026-05-07 evening).
--
-- Related:
--   platform/supabase/migrations/0014_admin_dashboard_read_access.sql (pattern source)
--   platform/supabase/migrations/0087_fastrack_submissions.sql (creates the table)
--   platform/app/app/admin/leads/[id]/page.tsx (consumer)

BEGIN;

CREATE POLICY admin_read_fastrack_submissions ON leads.fastrack_submissions
  FOR SELECT TO authenticated
  USING (admin.is_admin());

GRANT SELECT ON leads.fastrack_submissions TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- REVOKE SELECT ON leads.fastrack_submissions FROM authenticated;
-- DROP POLICY IF EXISTS admin_read_fastrack_submissions ON leads.fastrack_submissions;
-- COMMIT;
