-- Migration 0220 — add runs count to admin_labs_funnel RPC
-- Date: 2026-06-26
-- Author: Claude (labs session)
-- Reason: Dashboard needs Runs as a funnel step (Views → Runs → £17 clicks).
--         Currently the funnel skips from Views straight to £17 clicks, hiding
--         the intermediate conversion. Adding runs + run_to_unlock_pct.
-- Related: platform/app/app/admin/labs/page.tsx

-- UP
DROP FUNCTION IF EXISTS public.admin_labs_funnel();
CREATE FUNCTION public.admin_labs_funnel()
RETURNS TABLE(
  tool text,
  views bigint,
  runs bigint,
  unlock_intents bigint,
  radar_subscribes bigint,
  autopilot_subscribes bigint,
  view_to_unlock_pct numeric,
  run_to_unlock_pct numeric,
  unlock_to_radar_pct numeric,
  unlock_to_autopilot_pct numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  WITH tools(tool) AS (VALUES ('amistuck'), ('gaply')),
  agg AS (
    SELECT
      e.tool,
      count(DISTINCT e.session_id) FILTER (WHERE e.event = 'view')
        AS views,
      count(DISTINCT e.session_id) FILTER (WHERE e.event = 'run')
        AS runs,
      count(DISTINCT e.session_id) FILTER (WHERE e.event = 'unlock_intent')
        AS unlock_intents,
      count(DISTINCT e.session_id) FILTER (
        WHERE e.event = 'subscribe_click' AND e.payload->>'plan' = 'radar'
      ) AS radar_subscribes,
      count(DISTINCT e.session_id) FILTER (
        WHERE e.event = 'subscribe_click' AND e.payload->>'plan' = 'autopilot'
      ) AS autopilot_subscribes
    FROM labs.events e
    WHERE e.is_bot = false
    GROUP BY e.tool
  )
  SELECT
    t.tool,
    COALESCE(a.views, 0),
    COALESCE(a.runs, 0),
    COALESCE(a.unlock_intents, 0),
    COALESCE(a.radar_subscribes, 0),
    COALESCE(a.autopilot_subscribes, 0),
    ROUND(100.0 * a.unlock_intents       / NULLIF(a.views,          0), 1),
    ROUND(100.0 * a.unlock_intents       / NULLIF(a.runs,           0), 1),
    ROUND(100.0 * a.radar_subscribes     / NULLIF(a.unlock_intents, 0), 1),
    ROUND(100.0 * a.autopilot_subscribes / NULLIF(a.unlock_intents, 0), 1)
  FROM tools t
  LEFT JOIN agg a ON a.tool = t.tool
  ORDER BY t.tool;
$$;

-- DOWN
-- Restore previous version (without runs / run_to_unlock_pct columns):
-- CREATE OR REPLACE FUNCTION public.admin_labs_funnel() ... (see migration 0219)
