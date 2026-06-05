-- Migration 0188 — strategy.tasks (Work Hub "Run" altitude)
-- Date: 2026-06-05
-- Author: Claude (Sasha/platform session) with owner review
-- Reason: Phase 1 of the Work Hub (/admin/work) per platform/docs/admin-work-hub-spec.md.
--   The operational task table ("Run" work), linked to the existing roadmap rocks
--   ("Build" work) via roadmap_task_id. Front door for capture (UI + the task-upsert
--   EF that agents and the /handoff push call). Mirrors strategy.roadmap_tasks
--   conventions (uuid id, schema_version, sort_order, updated_at).
--
-- Access (mirrors strategy.roadmap_tasks):
--   - Owner: authenticated + admin.is_admin() FOR ALL (the admin app reads/writes).
--   - Mira (readonly_analytics): direct SELECT, to triage. NOTE: not routed through a
--     "direct-identifier-free view" (as the spec floated) because tasks has no
--     identifier columns to strip and triage needs the full title/notes — same as the
--     sibling roadmap_tasks, which readonly_analytics also reads directly. §6a targets
--     lead-PII tables; this operational task table isn't one.
--   - functions_writer: INSERT (+ SELECT for RETURNING) for the task-upsert EF.
-- area_tag is deliberately FREE TEXT (validated app-side), NOT a CHECK enum — the
--   business-area tag set evolves, and an enum CHECK that drifts ahead of the app is
--   exactly the bug just fixed in migration 0187. Validate in the app, not the DB.
-- Impact: new table + view-free direct grants; no existing object touched. New EF
--   (task-upsert) follows in this phase. schema_version 1.0.
-- Related: platform/docs/admin-work-hub-spec.md, strategy.roadmap_tasks.

-- UP
CREATE TABLE strategy.tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  notes           text,
  status          text NOT NULL DEFAULT 'inbox'
                    CHECK (status IN ('inbox', 'this_week', 'in_progress', 'review', 'done')),
  blocked         boolean NOT NULL DEFAULT false,
  blocked_reason  text,
  size            text NOT NULL DEFAULT 'small'
                    CHECK (size IN ('tiny', 'small', 'big')),
  area_tag        text,
  roadmap_task_id uuid REFERENCES strategy.roadmap_tasks(id) ON DELETE SET NULL,
  added_by        text NOT NULL,
  due_date        date,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  seen_by_owner   boolean NOT NULL DEFAULT false,
  schema_version  text NOT NULL DEFAULT '1.0'
);

CREATE INDEX tasks_status_sort_idx ON strategy.tasks (status, sort_order);
CREATE INDEX tasks_roadmap_task_id_idx ON strategy.tasks (roadmap_task_id);
CREATE INDEX tasks_due_date_idx ON strategy.tasks (due_date) WHERE due_date IS NOT NULL;
-- Drives the "added for you, not yet seen" notification feed.
CREATE INDEX tasks_unseen_feed_idx ON strategy.tasks (seen_by_owner) WHERE seen_by_owner = false;

-- Maintain updated_at, and auto-manage completed_at on status transitions to/from done.
CREATE OR REPLACE FUNCTION strategy.tasks_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  IF NEW.status = 'done' AND (OLD.status IS DISTINCT FROM 'done') THEN
    NEW.completed_at = now();
  ELSIF NEW.status <> 'done' THEN
    NEW.completed_at = NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tasks_touch_trg
  BEFORE UPDATE ON strategy.tasks
  FOR EACH ROW EXECUTE FUNCTION strategy.tasks_touch();

-- RLS
ALTER TABLE strategy.tasks ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA strategy TO functions_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON strategy.tasks TO authenticated;
GRANT SELECT ON strategy.tasks TO readonly_analytics;
GRANT SELECT, INSERT ON strategy.tasks TO functions_writer;

CREATE POLICY tasks_admin_all ON strategy.tasks
  FOR ALL TO authenticated USING (admin.is_admin()) WITH CHECK (admin.is_admin());
CREATE POLICY tasks_readonly_select ON strategy.tasks
  FOR SELECT TO readonly_analytics USING (true);
CREATE POLICY tasks_writer_insert ON strategy.tasks
  FOR INSERT TO functions_writer WITH CHECK (true);
CREATE POLICY tasks_writer_select ON strategy.tasks
  FOR SELECT TO functions_writer USING (true);

-- DOWN
-- DROP TABLE IF EXISTS strategy.tasks;  -- cascades indexes, policies, trigger
-- DROP FUNCTION IF EXISTS strategy.tasks_touch();
