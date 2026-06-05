-- Migration 0189 — add tags + priority to strategy.tasks (Work Hub)
-- Date: 2026-06-05
-- Author: Claude (Sasha/platform session) with owner review
-- Reason: owner wants richer cards (open to edit). Model:
--   - area_tag  = "Category", the single business area (free text, app-validated
--     against the canonical area list — deliberately NOT a CHECK enum, same
--     reasoning as 0187/0188: app-enum-ahead-of-CHECK is the drift trap).
--   - tags      = NEW multi-label array (quick-win, awaiting-approval, big-project,
--     etc.), free text array, app-managed.
--   - priority  = NEW (low/normal/high/urgent). Small stable set, CHECK is fine.
-- Impact: two additive columns with defaults; no existing object touched. EF
--   (work-tasks/task-upsert) + the /admin/work UI updated alongside.
-- Related: platform/docs/admin-work-hub-spec.md, migration 0188.

-- UP
ALTER TABLE strategy.tasks ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE strategy.tasks ADD COLUMN priority text NOT NULL DEFAULT 'normal'
  CHECK (priority IN ('low', 'normal', 'high', 'urgent'));

CREATE INDEX tasks_tags_gin_idx ON strategy.tasks USING gin (tags);

-- DOWN
-- DROP INDEX IF EXISTS strategy.tasks_tags_gin_idx;
-- ALTER TABLE strategy.tasks DROP COLUMN priority;
-- ALTER TABLE strategy.tasks DROP COLUMN tags;
