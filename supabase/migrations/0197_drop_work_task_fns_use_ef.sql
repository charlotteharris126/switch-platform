-- Migration 0197 — drop add_work_task / update_work_task; agents use the EF instead
-- Date: 2026-06-08
-- Author: Claude (Sasha/platform) with owner sign-off
-- Reason: 0194 added SECURITY DEFINER add/update functions so agents could write a
--   task through their read-only Postgres MCP. Testing showed the MCP wraps every
--   query in a READ ONLY transaction, which refuses writes even from a SECURITY
--   DEFINER function ("cannot execute INSERT in a read-only transaction"). So the
--   functions cannot serve their purpose. The agent + /handoff capture path is the
--   task-upsert Edge Function (bearer-gated, writes via functions_writer) which now
--   also handles updates/tick-off. Dropping the functions removes the dead code and
--   the readonly_analytics EXECUTE grant — so the §11 "agents never write" model is
--   left fully intact (no exception needed after all).
-- Impact: drops two unused functions; no consumer depends on them (the admin app
--   writes via the work-tasks EF, not these). No data touched.

-- UP
DROP FUNCTION IF EXISTS public.add_work_task(text, text, text, text, text, text, text[], date);
DROP FUNCTION IF EXISTS public.update_work_task(uuid, text, text, text, text, text, text[], date, boolean, text, boolean);

-- DOWN
-- (re-create per migration 0194 if a non-MCP, read-write caller ever needs them)
