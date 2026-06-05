-- Migration 0190 — add 'agents' status to strategy.tasks (Work Hub)
-- Date: 2026-06-05
-- Author: Claude (Sasha/platform session) with owner review
-- Reason: new kanban column "Agents" — a lane for tasks delegated to an agent
--   (vs the owner's own Inbox→Done flow). A task in Agents, tagged to a project
--   (area_tag), is what that project's agent picks up on its run. Updating the
--   status CHECK in lockstep with both EFs (VALID_STATUS / ALLOWED_STATUS) and
--   the board COLUMNS — the app-enum-ahead-of-CHECK drift is the 0187 bug.
-- Impact: additive (one more allowed status value); no existing row affected.
-- Related: platform/docs/admin-work-hub-spec.md, work-tasks/task-upsert EFs,
--   app/admin/work/work-board.tsx.

-- UP
ALTER TABLE strategy.tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE strategy.tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('inbox', 'agents', 'this_week', 'in_progress', 'review', 'done'));

-- DOWN
-- ALTER TABLE strategy.tasks DROP CONSTRAINT tasks_status_check;
-- ALTER TABLE strategy.tasks ADD CONSTRAINT tasks_status_check
--   CHECK (status IN ('inbox', 'this_week', 'in_progress', 'review', 'done'));
