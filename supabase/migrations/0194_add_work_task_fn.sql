-- Migration 0194 — add + update Work Hub task functions for agents + /handoff
-- Date: 2026-06-08
-- Author: Claude (Sasha/platform) with owner sign-off
-- Reason: the ClickUp cutover. Agents and the /handoff process run as Claude with
--   the read-only Postgres MCP (readonly_analytics). Give them two SECURITY DEFINER
--   functions to ADD and UPDATE a task on the owner's Work Hub board — controlled,
--   single-row writes scoped to strategy.tasks ONLY. No read/write access to any
--   business table (leads, crm, billing) is granted. Delete stays owner-only.
-- Assessed exception to data-infrastructure.md §11 ("agents never write"): §11
--   protects business data from silent agent mutation. These functions touch only
--   the owner's personal task board and nothing else, so that protection is intact.
--   Signed off by owner 2026-06-08. Logged in platform/docs/changelog.md.
-- Impact: two new functions; EXECUTE granted to readonly_analytics (agents/handoff
--   via MCP), authenticated + service_role (admin app). Both run as definer (postgres)
--   and write only strategy.tasks, with status/priority validation.
-- Related: platform/docs/admin-work-hub-spec.md, migration 0188.

-- UP
-- (1) ADD a task.
CREATE OR REPLACE FUNCTION public.add_work_task(
  p_title     text,
  p_added_by  text,
  p_area_tag  text DEFAULT NULL,
  p_priority  text DEFAULT 'normal',
  p_status    text DEFAULT 'inbox',
  p_notes     text DEFAULT NULL,
  p_tags      text[] DEFAULT '{}',
  p_due_date  date DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_id uuid;
BEGIN
  IF p_title IS NULL OR length(btrim(p_title)) = 0 THEN
    RAISE EXCEPTION 'add_work_task: title required';
  END IF;
  IF p_added_by IS NULL OR length(btrim(p_added_by)) = 0 THEN
    RAISE EXCEPTION 'add_work_task: added_by required';
  END IF;
  INSERT INTO strategy.tasks (title, added_by, area_tag, priority, status, notes, tags, due_date)
  VALUES (
    btrim(p_title),
    btrim(p_added_by),
    p_area_tag,
    CASE WHEN p_priority IN ('low','normal','high','urgent') THEN p_priority ELSE 'normal' END,
    CASE WHEN p_status IN ('backlog','inbox','agents','this_week','in_progress','review','done') THEN p_status ELSE 'inbox' END,
    p_notes,
    COALESCE(p_tags, '{}'),
    p_due_date
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- (2) UPDATE a task (incl. ticking off via p_status => 'done'). NULL args = leave unchanged.
CREATE OR REPLACE FUNCTION public.update_work_task(
  p_id        uuid,
  p_title     text DEFAULT NULL,
  p_status    text DEFAULT NULL,
  p_priority  text DEFAULT NULL,
  p_area_tag  text DEFAULT NULL,
  p_notes     text DEFAULT NULL,
  p_tags      text[] DEFAULT NULL,
  p_due_date  date DEFAULT NULL,
  p_blocked   boolean DEFAULT NULL,
  p_blocked_reason text DEFAULT NULL,
  p_clear_due_date boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_found boolean;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'update_work_task: id required';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('backlog','inbox','agents','this_week','in_progress','review','done') THEN
    RAISE EXCEPTION 'update_work_task: invalid status %', p_status;
  END IF;
  IF p_priority IS NOT NULL AND p_priority NOT IN ('low','normal','high','urgent') THEN
    RAISE EXCEPTION 'update_work_task: invalid priority %', p_priority;
  END IF;
  UPDATE strategy.tasks SET
    title         = COALESCE(NULLIF(btrim(p_title), ''), title),
    status        = COALESCE(p_status, status),
    priority      = COALESCE(p_priority, priority),
    area_tag      = COALESCE(p_area_tag, area_tag),
    notes         = COALESCE(p_notes, notes),
    tags          = COALESCE(p_tags, tags),
    due_date      = CASE WHEN p_clear_due_date THEN NULL ELSE COALESCE(p_due_date, due_date) END,
    blocked       = COALESCE(p_blocked, blocked),
    blocked_reason = COALESCE(p_blocked_reason, blocked_reason)
  WHERE id = p_id
  RETURNING true INTO v_found;
  RETURN COALESCE(v_found, false);
END $$;

REVOKE EXECUTE ON FUNCTION public.add_work_task(text, text, text, text, text, text, text[], date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_work_task(uuid, text, text, text, text, text, text[], date, boolean, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_work_task(text, text, text, text, text, text, text[], date)
  TO readonly_analytics, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_work_task(uuid, text, text, text, text, text, text[], date, boolean, text, boolean)
  TO readonly_analytics, authenticated, service_role;

-- DOWN
-- DROP FUNCTION IF EXISTS public.add_work_task(text, text, text, text, text, text, text[], date);
-- DROP FUNCTION IF EXISTS public.update_work_task(uuid, text, text, text, text, text, text[], date, boolean, text, boolean);
