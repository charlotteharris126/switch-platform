-- Migration 0195 — add 'backlog' status to strategy.tasks (Work Hub)
-- Date: 2026-06-08
-- Author: Claude (Sasha/platform) with owner sign-off
-- Reason: new "Backlog / Ideas" column on the Work Hub — a brain-dump pool the
--   owner reviews periodically, distinct from Inbox (triage-soon). Additive status
--   value. Kept in lockstep (per the CHECK-enum lesson, migration 0187) with both
--   EFs (work-tasks VALID_STATUS, task-upsert ALLOWED_STATUS), the add/update
--   functions (0194), the WorkTask TS type, and the board COLUMNS.
-- Impact: additive (one more allowed status value); no existing row affected.

-- UP
ALTER TABLE strategy.tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE strategy.tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('backlog', 'inbox', 'agents', 'this_week', 'in_progress', 'review', 'done'));

-- DOWN
-- ALTER TABLE strategy.tasks DROP CONSTRAINT tasks_status_check;
-- ALTER TABLE strategy.tasks ADD CONSTRAINT tasks_status_check
--   CHECK (status IN ('inbox', 'agents', 'this_week', 'in_progress', 'review', 'done'));
