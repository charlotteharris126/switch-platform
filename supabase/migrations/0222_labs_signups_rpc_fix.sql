-- Migration 0222 — fix admin_labs_recent_signups: show all signups, add signups to funnel
-- Date: 2026-06-27
-- Author: Claude (labs session) with owner review
-- Reason: Two issues found:
--   (1) admin_labs_recent_signups filters email IS NOT NULL, hiding rows where the
--       email capture failed (EF validation edge case or timing issue). Better to show
--       all signup events with email as blank when null, so owner can see the event fired.
--   (2) admin_labs_funnel (v3) removed 'signups' from the funnel in 0219, making it
--       invisible unless you scroll to the recent-signups section. Re-adding signups count
--       as a funnel step so the conversion path is fully visible:
--       Views → Runs → £17 clicks → Signups (email) → Radar → Autopilot
-- Related: 0183 (original RPCs), 0219/0220 (funnel v2/v3), platform/app/app/admin/labs/page.tsx

-- UP

-- 1. Fix recent_signups: remove the email IS NOT NULL guard so any signup event shows.
--    is_bot filter stays (bot signups are not meaningful to surface).
DROP FUNCTION IF EXISTS public.admin_labs_recent_signups(integer);

CREATE FUNCTION public.admin_labs_recent_signups(p_limit integer DEFAULT 25)
RETURNS TABLE (
  created_at  timestamptz,
  tool        text,
  email       text,
  payload     jsonb,
  attribution jsonb
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT e.created_at, e.tool, e.email, e.payload, e.attribution
  FROM labs.events e
  WHERE e.event = 'signup' AND e.is_bot = false
  ORDER BY e.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 25), 200));
$$;

REVOKE EXECUTE ON FUNCTION public.admin_labs_recent_signups(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_labs_recent_signups(integer) TO service_role;

-- 2. Update funnel to add signups count (email captures).
--    Return type changes so must drop and recreate.
DROP FUNCTION IF EXISTS public.admin_labs_funnel();

CREATE FUNCTION public.admin_labs_funnel()
RETURNS TABLE (
  tool                      text,
  views                     bigint,
  runs                      bigint,
  unlock_intents            bigint,
  signups                   bigint,
  radar_subscribes          bigint,
  autopilot_subscribes      bigint,
  view_to_unlock_pct        numeric,
  run_to_unlock_pct         numeric,
  unlock_to_signup_pct      numeric,
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
      count(DISTINCT e.session_id) FILTER (WHERE e.event = 'view')           AS views,
      count(DISTINCT e.session_id) FILTER (WHERE e.event = 'run')            AS runs,
      count(DISTINCT e.session_id) FILTER (WHERE e.event = 'unlock_intent')  AS unlock_intents,
      count(DISTINCT e.session_id) FILTER (WHERE e.event = 'signup')         AS signups,
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
    COALESCE(a.signups, 0),
    COALESCE(a.radar_subscribes, 0),
    COALESCE(a.autopilot_subscribes, 0),
    ROUND(100.0 * a.unlock_intents       / NULLIF(a.views,          0), 1),
    ROUND(100.0 * a.unlock_intents       / NULLIF(a.runs,           0), 1),
    ROUND(100.0 * a.signups              / NULLIF(a.unlock_intents, 0), 1),
    ROUND(100.0 * a.radar_subscribes     / NULLIF(a.unlock_intents, 0), 1),
    ROUND(100.0 * a.autopilot_subscribes / NULLIF(a.unlock_intents, 0), 1)
  FROM tools t
  LEFT JOIN agg a ON a.tool = t.tool
  ORDER BY t.tool;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_labs_funnel() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_labs_funnel() TO service_role;

-- DOWN
-- Restore v3 funnel (without signups):
-- DROP FUNCTION IF EXISTS public.admin_labs_funnel();
-- CREATE FUNCTION public.admin_labs_funnel() ... (see 0220)
-- DROP FUNCTION IF EXISTS public.admin_labs_recent_signups(integer);
-- CREATE FUNCTION public.admin_labs_recent_signups(p_limit integer DEFAULT 25) ... (see 0183, with email IS NOT NULL)
