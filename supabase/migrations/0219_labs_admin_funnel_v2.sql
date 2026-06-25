-- Migration 0219 — update admin_labs_funnel RPC (v2) + add admin_labs_targeting RPC
-- Date: 2026-06-25
-- Author: Claude (Sasha session) with owner review
-- Reason: The v1 funnel (runs / unlock_intents / signups) doesn't match the actual
--   Gaply conversion path. New shape:
--     views (page loads) → £17 clicks (unlock_intent) → Radar subscribe | Autopilot subscribe
--   The old "signups" column (email captured) disappears from the funnel table; email
--   capture is still tracked in labs.events and shown in the recent-signups table.
--   admin_labs_targeting is a new RPC that aggregates run-event payload data (town,
--   skills, interests, budget) so the admin page can show who is using the tool.
-- Related: 0183 (v1), 0218 (view event), platform/app/app/admin/labs/page.tsx.

-- UP

-- Must drop before replace because the return type changes (different OUT columns).
DROP FUNCTION IF EXISTS public.admin_labs_funnel();

CREATE FUNCTION public.admin_labs_funnel()
RETURNS TABLE (
  tool                      text,
  views                     bigint,
  unlock_intents            bigint,
  radar_subscribes          bigint,
  autopilot_subscribes      bigint,
  view_to_unlock_pct        numeric,
  unlock_to_radar_pct       numeric,
  unlock_to_autopilot_pct   numeric
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  WITH tools(tool) AS (VALUES ('amistuck'), ('gaply')),
  agg AS (
    SELECT
      e.tool,
      count(DISTINCT e.session_id) FILTER (WHERE e.event = 'view')
        AS views,
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
    COALESCE(a.unlock_intents, 0),
    COALESCE(a.radar_subscribes, 0),
    COALESCE(a.autopilot_subscribes, 0),
    ROUND(100.0 * a.unlock_intents    / NULLIF(a.views,          0), 1),
    ROUND(100.0 * a.radar_subscribes  / NULLIF(a.unlock_intents, 0), 1),
    ROUND(100.0 * a.autopilot_subscribes / NULLIF(a.unlock_intents, 0), 1)
  FROM tools t
  LEFT JOIN agg a ON a.tool = t.tool
  ORDER BY t.tool;
$$;

-- Targeting data: aggregated payload signals from 'run' events.
-- Returns (category, value, cnt) rows; frontend groups by category.
-- Categories: town, skill, interest, budget.
-- No PII — all values are selections the user made from a fixed pick-list or typed
-- a town name (low-sensitivity). Not linked to individual sessions.
CREATE OR REPLACE FUNCTION public.admin_labs_targeting(p_tool text DEFAULT 'gaply')
RETURNS TABLE (category text, value text, cnt bigint)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  -- Top towns
  SELECT 'town'::text AS category, lower(e.payload->>'town') AS value, count(*)::bigint AS cnt
  FROM labs.events e
  WHERE e.tool = p_tool AND e.event = 'run' AND e.is_bot = false
    AND e.payload->>'town' IS NOT NULL
  GROUP BY lower(e.payload->>'town')

  UNION ALL

  -- Top skills (array)
  SELECT 'skill'::text, s.val, count(*)::bigint
  FROM labs.events e,
       jsonb_array_elements_text(e.payload->'skills') AS s(val)
  WHERE e.tool = p_tool AND e.event = 'run' AND e.is_bot = false
    AND jsonb_typeof(e.payload->'skills') = 'array'
  GROUP BY s.val

  UNION ALL

  -- Top interests (array)
  SELECT 'interest'::text, i.val, count(*)::bigint
  FROM labs.events e,
       jsonb_array_elements_text(e.payload->'interests') AS i(val)
  WHERE e.tool = p_tool AND e.event = 'run' AND e.is_bot = false
    AND jsonb_typeof(e.payload->'interests') = 'array'
  GROUP BY i.val

  UNION ALL

  -- Budget preference
  SELECT 'budget'::text, e.payload->'prefs'->>'budget', count(*)::bigint
  FROM labs.events e
  WHERE e.tool = p_tool AND e.event = 'run' AND e.is_bot = false
    AND e.payload->'prefs'->>'budget' IS NOT NULL
  GROUP BY e.payload->'prefs'->>'budget'

  ORDER BY 1, 3 DESC;
$$;

-- Inherit the same service_role-only EXECUTE as the other admin RPCs.
REVOKE EXECUTE ON FUNCTION public.admin_labs_targeting(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_labs_targeting(text) TO service_role;

-- DOWN
-- Restore v1 funnel signature (drops targeting fn — no data lost):
-- DROP FUNCTION IF EXISTS public.admin_labs_targeting(text);
-- CREATE OR REPLACE FUNCTION public.admin_labs_funnel()
-- RETURNS TABLE (tool text, runs bigint, unlock_intents bigint, signups bigint,
--                run_to_unlock_pct numeric, run_to_signup_pct numeric, unlock_to_signup_pct numeric)
-- ... (see 0183 for original body)
