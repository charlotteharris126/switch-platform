-- Migration 0050 — admin SELECT access on ads_switchable.meta_daily
-- Date: 2026-05-02
-- Author: Claude (Session 22) with owner review
-- Reason: Backfill of Meta ads ingest landed 98 rows in ads_switchable.meta_daily
-- but the admin dashboard couldn't read them. RLS on meta_daily was set up in
-- migration 0001 with policies for `readonly_analytics` (for Metabase / Iris
-- via Postgres MCP) and `ads_ingest` (for the meta-ads-ingest Edge Function)
-- only. The dashboard server client runs as `authenticated`, which had neither
-- schema USAGE nor table SELECT, so every read returned 0 rows or 42501.
--
-- This explains why /admin/ads has shown "No spend logged yet" up to now:
-- both the previous manual-paste row reads and Session 21's tile placeholders
-- have been silently RLS-blocked.
--
-- Mirrors the pattern from migration 0047 (sheet_edits_log + pending_updates):
-- USAGE on schema, SELECT on table, then a permissive admin_read_* policy.
-- Auth gate to the dashboard itself is enforced upstream by the
-- ADMIN_ALLOWLIST middleware; rejecting non-admin authenticated users from
-- reading meta_daily is therefore unnecessary at the DB layer.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: grants `authenticated` role schema USAGE and table SELECT on
--      ads_switchable.meta_daily, plus a permissive RLS read policy.
--   2. Readers affected: /admin (Overview), /admin/ads, /admin/errors. They
--      currently see "—" / "No spend logged" because of this gap.
--   3. Writers: unchanged. `ads_ingest` retains FOR ALL policy.
--   4. Schema version: not affected (no payload contract change).
--   5. Data migration: none.
--   6. New role/policy: yes, `admin_read_meta_daily` SELECT policy.
--   7. Rollback: revoke + drop policy in DOWN.
--   8. Sign-off: owner (this session).
--
-- Related:
--   platform/supabase/migrations/0001_init_pilot_schemas.sql (original RLS)
--   platform/supabase/migrations/0047_sheet_mirror_tables.sql (same pattern)
--   platform/docs/changelog.md — Session 22 entry

-- UP

GRANT USAGE ON SCHEMA ads_switchable TO authenticated;
GRANT SELECT ON ads_switchable.meta_daily TO authenticated;

CREATE POLICY admin_read_meta_daily
  ON ads_switchable.meta_daily
  FOR SELECT
  TO authenticated
  USING (true);

-- DOWN
-- DROP POLICY IF EXISTS admin_read_meta_daily ON ads_switchable.meta_daily;
-- REVOKE SELECT ON ads_switchable.meta_daily FROM authenticated;
-- REVOKE USAGE ON SCHEMA ads_switchable FROM authenticated;
