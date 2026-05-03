-- Migration 0064 — readonly_analytics RLS policy on iris_flags
-- Date: 2026-05-03
-- Author: Claude (Sasha session) with owner review
-- Reason: Migration 0056 created iris_flags with RLS policies for the
--   authenticated (dashboard) and iris_writer (Edge Function) roles only.
--   The readonly_analytics role (used by agents via Postgres MCP and by
--   Metabase) was given SELECT grant via the migration-0001 default-grant
--   ALTER DEFAULT PRIVILEGES inheritance, but no RLS read policy was added
--   for it. Result: agents see zero rows on every iris_flags query, even
--   though the data is there.
--
--   Per .claude/rules/data-infrastructure.md §11: "Agents can read all tables
--   and views." This policy closes the gap so Iris (when invoked for
--   strategic work via MCP) can read her own flag history.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new SELECT policy on iris_flags for readonly_analytics.
--   2. Readers affected: enables agents + Metabase to read iris_flags. No
--      writers affected.
--   3. Schema version: not affected.
--   4. Data migration: none.
--   5. New role/policy: yes — `readonly_analytics_read_iris_flags`.
--   6. Rollback: DROP POLICY in DOWN.
--   7. Sign-off: owner (this session).
--
-- Related:
--   platform/supabase/migrations/0056_iris_flags_foundation.sql
--   .claude/rules/data-infrastructure.md §11
-- =============================================================================

BEGIN;

CREATE POLICY readonly_analytics_read_iris_flags
  ON ads_switchable.iris_flags
  FOR SELECT
  TO readonly_analytics
  USING (true);

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP POLICY readonly_analytics_read_iris_flags ON ads_switchable.iris_flags;
-- COMMIT;
