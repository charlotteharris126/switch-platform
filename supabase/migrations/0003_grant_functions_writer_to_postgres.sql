-- Migration 0003 — Grant functions_writer role to postgres for SET ROLE use
-- Date: 2026-04-18
-- Author: Claude (Session 2) with owner review
-- Reason: The Edge Function netlify-lead-router connects via the auto-injected
--         SUPABASE_DB_URL (postgres superuser) and uses SET LOCAL ROLE
--         functions_writer inside every transaction to honour the scoped-role
--         discipline from .claude/rules/data-infrastructure.md §5 + §6.
--
--         In Supabase, the `postgres` role is not automatically a member of
--         custom roles created by migrations. SET LOCAL ROLE therefore fails
--         with "permission denied to set role". This migration fixes it with
--         a single GRANT.
--
-- Impact:
--   - Enables the Edge Function's SET LOCAL ROLE pattern. No change to
--     functions_writer's own permissions.
--   - The same pattern will be used by future Edge Functions that need to
--     write. If we later add another scoped writer role (e.g.
--     `ads_ingest_writer`), the same grant will be needed for it.
--
-- Before running:
--   Paste into Supabase SQL Editor as the postgres role.

-- UP

GRANT functions_writer TO postgres;

-- Verification — run after the migration:
--   SELECT r.rolname AS member, b.rolname AS granted
--   FROM pg_auth_members m
--   JOIN pg_roles r ON r.oid = m.member
--   JOIN pg_roles b ON b.oid = m.roleid
--   WHERE b.rolname = 'functions_writer';
--     Expected: one row, member=postgres granted=functions_writer.

-- DOWN
-- REVOKE functions_writer FROM postgres;
