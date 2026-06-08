-- Migration 0199 — let functions_writer UPDATE strategy.tasks (capture EF tick-off)
-- Date: 2026-06-08
-- Author: Claude (Sasha/platform) with owner sign-off
-- Reason: the task-upsert EF now updates tasks (tick-off/edit by agents + /handoff)
--   via SET LOCAL ROLE functions_writer, but 0188 only granted functions_writer
--   SELECT + INSERT, so the UPDATE failed. Grant UPDATE + the matching RLS policy
--   (a TO-role policy needs a table GRANT for that role too). Still no DELETE for
--   functions_writer — removal stays owner-only.
-- Impact: functions_writer gains UPDATE on strategy.tasks only. No new role, no
--   data change. Rollback in DOWN.

-- UP
GRANT UPDATE ON strategy.tasks TO functions_writer;

CREATE POLICY tasks_functions_writer_update ON strategy.tasks
  FOR UPDATE TO functions_writer USING (true) WITH CHECK (true);

-- DOWN
-- DROP POLICY IF EXISTS tasks_functions_writer_update ON strategy.tasks;
-- REVOKE UPDATE ON strategy.tasks FROM functions_writer;
