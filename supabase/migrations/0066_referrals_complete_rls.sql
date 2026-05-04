-- Migration 0066 — complete RLS policy set on leads.referrals
-- Date: 2026-05-04
-- Author: Claude (Sasha session) with owner review
-- Reason: Migration 0053 created leads.referrals with only two RLS policies
--   (admin_read_referrals, admin_update_referrals — both gating on
--   admin.is_admin()). Two real gaps surfaced in the platform RLS audit:
--
--   1. functions_writer has no INSERT policy. Both processReferral
--      (netlify-lead-router fast path + netlify-leads-reconcile slow path)
--      do `SET LOCAL ROLE functions_writer` then INSERT into leads.referrals.
--      With no INSERT policy for that role, RLS blocks the write. Hasn't
--      surfaced because zero referrals have flowed through production yet
--      (table has 0 rows). First production `?ref=CODE` submission would
--      fail.
--
--   2. readonly_analytics has no SELECT policy. Agents (Iris, Mira, Sasha)
--      and Metabase reading via Postgres MCP can't see referral rows.
--      Same gap as iris_flags had until migration 0064 closed it.
--
-- Per .claude/rules/data-infrastructure.md §11: agents can read all tables
-- and views. Per the existing policy patterns on leads.submissions and
-- leads.routing_log, functions_writer needs ALL-grants for the lead-ingest
-- pipeline.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: 2 new RLS policies on leads.referrals (one INSERT for
--      functions_writer, one SELECT for readonly_analytics).
--   2. Readers/writers affected: unblocks Edge Function INSERT (processReferral
--      becomes runnable), enables agent + Metabase reads.
--   3. Schema version: not affected.
--   4. Data migration: none.
--   5. New role/policy: yes — 2 policies, no new roles.
--   6. Rollback: DROP POLICY in DOWN.
--   7. Sign-off: owner (this session, RLS quarterly audit).
--
-- Related:
--   platform/supabase/migrations/0053_add_referral_programme.sql (created table)
--   platform/supabase/functions/_shared/referral.ts (the consumer)
-- =============================================================================

BEGIN;

CREATE POLICY functions_writer_insert_referrals
  ON leads.referrals
  FOR INSERT
  TO functions_writer
  WITH CHECK (true);

CREATE POLICY readonly_analytics_read_referrals
  ON leads.referrals
  FOR SELECT
  TO readonly_analytics
  USING (true);

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP POLICY readonly_analytics_read_referrals ON leads.referrals;
-- DROP POLICY functions_writer_insert_referrals ON leads.referrals;
-- COMMIT;
