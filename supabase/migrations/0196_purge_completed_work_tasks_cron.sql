-- Migration 0196 — daily auto-clear of completed Work Hub tasks (30-day retention)
-- Date: 2026-06-08
-- Author: Claude (Sasha/platform) with owner sign-off
-- Reason: completed tasks (status 'done') live in a hidden "Completed" column so
--   the board stays clean, but they'd accumulate forever. This cron deletes done
--   tasks whose completion is older than 30 days, so Completed never balloons.
--   Scope is strict: ONLY status='done' with a real completed_at older than 30
--   days. Backlog/ideas and every active task are never touched — ideas persist
--   for periodic review by design.
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: one pg_cron schedule (daily). No DDL, no new table/column.
--   2. Readers/writers: deletes from strategy.tasks only. No other consumer.
--   3. schema_version: none bumped.
--   4. Data migration: none.
--   5. New role/policy: none. Runs as the cron owner (postgres).
--   6. Rollback: cron.unschedule in DOWN.
--   7. Sign-off: owner 2026-06-08.
-- Why 30 days: long enough to keep a recent "what got done" history visible on
--   demand, short enough that the hidden column never grows without bound. The
--   owner can lengthen by editing the interval in a follow-up migration.

-- UP
SELECT cron.schedule(
  'purge-completed-work-tasks',
  '15 3 * * *',
  $$DELETE FROM strategy.tasks
      WHERE status = 'done'
        AND completed_at IS NOT NULL
        AND completed_at < now() - interval '30 days'$$
);

-- DOWN
-- SELECT cron.unschedule('purge-completed-work-tasks');
