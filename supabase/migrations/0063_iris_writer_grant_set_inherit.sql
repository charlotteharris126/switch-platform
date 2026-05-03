-- Migration 0063 — grant SET + INHERIT options on iris_writer to postgres
-- Date: 2026-05-03
-- Author: Claude (Sasha session) with owner review
-- Reason: Migration 0056 created the iris_writer role but the implicit
--   membership granted to the postgres superuser landed with only the
--   admin_option (postgres can manage iris_writer's own grants) and not the
--   set_option or inherit_option (postgres cannot SET ROLE iris_writer in a
--   session). Postgres 16+ split role-membership into three separate flags
--   and this default-grant case lands without SET/INHERIT.
--
--   The Edge Function `iris-daily-flags` (just deployed) connects as postgres
--   and tries `SET LOCAL ROLE iris_writer` to write through the scoped role
--   per data-infrastructure rule §11. That call fails with "permission
--   denied to set role iris_writer" without this fix.
--
--   Mirrors the membership state of `functions_writer`, which already has
--   both SET TRUE and INHERIT TRUE on postgres (verified via pg_auth_members).
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: GRANT iris_writer TO postgres WITH SET TRUE INHERIT TRUE.
--   2. Readers/writers affected: enables iris-daily-flags Edge Function to
--      complete its INSERT transactions. No other surface affected.
--   3. Schema version: not affected.
--   4. Data migration: none.
--   5. New role/policy: no.
--   6. Rollback: REVOKE in DOWN.
--   7. Sign-off: owner (this session).
--
-- Related:
--   platform/supabase/migrations/0056_iris_flags_foundation.sql (created role)
--   platform/supabase/functions/iris-daily-flags/index.ts (consumer)
-- =============================================================================

BEGIN;

GRANT iris_writer TO postgres WITH SET TRUE, INHERIT TRUE;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- REVOKE SET, INHERIT FOR iris_writer FROM postgres;
-- COMMIT;
