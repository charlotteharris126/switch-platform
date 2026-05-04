-- Migration 0069 — add INSERT RLS policy for functions_writer on page_views
-- Date: 2026-05-04
-- Author: Claude (platform session) with owner review
-- Reason: Migration 0068 enabled RLS and granted INSERT to functions_writer but
--   omitted the INSERT RLS policy. PostgreSQL requires both the privilege grant
--   AND a matching policy for non-superuser roles. Without the policy, every
--   INSERT by the log-page-view Edge Function was silently rejected by RLS
--   (the function returns 200 regardless, so the failure was invisible).
-- Related: 0068_page_views.sql, platform/supabase/functions/log-page-view/index.ts

-- UP
CREATE POLICY "functions_writer_insert_page_views"
  ON ads_switchable.page_views
  FOR INSERT TO functions_writer
  WITH CHECK (true);

-- DOWN
-- DROP POLICY IF EXISTS "functions_writer_insert_page_views" ON ads_switchable.page_views;