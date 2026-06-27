-- Migration 0221 — add admin_labs_recent_runs RPC
-- Date: 2026-06-26
-- Author: Claude (labs session)
-- Reason: Querying labs.events directly via .schema("labs") from the JS client
--         fails because labs is not in the Data API exposed schemas list.
--         RPC bypasses this — same pattern as admin_labs_funnel and admin_labs_targeting.
-- Related: platform/app/app/admin/labs/page.tsx

-- UP
CREATE OR REPLACE FUNCTION public.admin_labs_recent_runs(
  p_tool text DEFAULT 'gaply',
  p_limit int DEFAULT 20
)
RETURNS TABLE(
  id bigint,
  created_at timestamptz,
  payload jsonb,
  attribution jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT
    e.id,
    e.created_at,
    e.payload,
    e.attribution
  FROM labs.events e
  WHERE e.tool = p_tool
    AND e.event = 'run'
    AND e.is_bot = false
  ORDER BY e.created_at DESC
  LIMIT p_limit;
$$;

-- DOWN
-- DROP FUNCTION IF EXISTS public.admin_labs_recent_runs(text, int);
