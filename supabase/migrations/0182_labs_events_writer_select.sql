-- Migration 0182 — functions_writer SELECT on labs.events
-- Date: 2026-06-03
-- Author: Claude (Labs session) with owner review
-- Reason: the labs-event Edge Function uses INSERT ... RETURNING id. RETURNING
--   requires SELECT privilege (and an RLS read path) in addition to INSERT.
--   Migration 0181 granted functions_writer INSERT only, so the RETURNING failed
--   with "permission denied for table events". Grant SELECT + a matching RLS read
--   policy (mirrors functions_writer's read on leads.partials).
-- Related: 0181_labs_events.sql, platform/supabase/functions/labs-event/index.ts

-- UP
GRANT SELECT ON labs.events TO functions_writer;
CREATE POLICY labs_events_select_writer ON labs.events
  FOR SELECT TO functions_writer USING (true);

-- DOWN
-- DROP POLICY IF EXISTS labs_events_select_writer ON labs.events;
-- REVOKE SELECT ON labs.events FROM functions_writer;
