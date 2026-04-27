-- Migration 0002 — Rename n8n legacy names to tool-neutral ones
-- Date: 2026-04-18
-- Author: Claude (Session 2) with owner review
-- Reason: Migration 0001 named the write-path role `n8n_writer` and the
--         routing_log traceback column `n8n_execution_id` at a time when n8n
--         was the chosen workflow tool. On 2026-04-18 the tool choice for the
--         data layer was reversed to Supabase Edge Functions (see
--         platform/docs/changelog.md "Architectural reversal" entry). Leaving
--         the n8n names causes active confusion — the name suggests a tool
--         we're not using. Renaming now is one-line-of-SQL cheap and the role
--         has zero active users and the column zero rows.
--
-- Impact:
--   - Any caller using the `n8n_writer` role must update their connection
--     string to `functions_writer` after this ships. As of writing, the only
--     caller is the deployed Edge Function `netlify-lead-router`, whose secret
--     will also be renamed in the same session (function code + Supabase
--     dashboard secret both updated — see related changelog entry).
--   - The column `leads.routing_log.n8n_execution_id` has zero rows. Rename
--     is safe; no data to migrate.
--
-- Before running:
--   1. Confirm no process is holding an active connection as `n8n_writer`.
--      (Supabase dashboard → Database → Roles → n8n_writer → connections. Or
--      query pg_stat_activity.)
--   2. Run this entire file as one transaction in the Supabase SQL editor as
--      the postgres superuser.
--
-- Rollback (DOWN): trivial, mirror the RENAME statements.

-- UP

ALTER ROLE n8n_writer RENAME TO functions_writer;

ALTER TABLE leads.routing_log RENAME COLUMN n8n_execution_id TO execution_id;

-- Verification — run after the migration:
--   SELECT rolname FROM pg_roles WHERE rolname IN ('n8n_writer', 'functions_writer');
--     Expected: one row, functions_writer.
--   SELECT column_name FROM information_schema.columns
--     WHERE table_schema='leads' AND table_name='routing_log' AND column_name LIKE '%execution%';
--     Expected: one row, execution_id.

-- DOWN
-- ALTER ROLE functions_writer RENAME TO n8n_writer;
-- ALTER TABLE leads.routing_log RENAME COLUMN execution_id TO n8n_execution_id;
