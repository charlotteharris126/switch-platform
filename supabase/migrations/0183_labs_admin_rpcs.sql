-- Migration 0183 — admin RPCs for the Labs funnel (/admin/labs)
-- Date: 2026-06-03
-- Author: Claude (Labs session) with owner review
-- Reason: surface the Labs smoke-test funnel in the admin app. labs.events is not
--   exposed to PostgREST, and signup emails are PII, so read it via SECURITY DEFINER
--   functions in public, locked to service_role only (the admin page uses the
--   service client; layout-gated to admins). Bot rows excluded; sessions deduped.
-- Related: 0181/0182 (labs.events), platform/app/app/admin/labs/page.tsx

-- UP
CREATE OR REPLACE FUNCTION public.admin_labs_funnel()
RETURNS TABLE (
  tool                 text,
  runs                 bigint,
  unlock_intents       bigint,
  signups              bigint,
  run_to_unlock_pct    numeric,
  run_to_signup_pct    numeric,
  unlock_to_signup_pct numeric
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
      count(DISTINCT e.session_id) FILTER (WHERE e.event = 'run')           AS runs,
      count(DISTINCT e.session_id) FILTER (WHERE e.event = 'unlock_intent') AS unlock_intents,
      count(DISTINCT e.session_id) FILTER (WHERE e.event = 'signup')        AS signups
    FROM labs.events e
    WHERE e.is_bot = false
    GROUP BY e.tool
  )
  SELECT
    t.tool,
    COALESCE(a.runs, 0),
    COALESCE(a.unlock_intents, 0),
    COALESCE(a.signups, 0),
    ROUND(100.0 * a.unlock_intents / NULLIF(a.runs, 0), 1),
    ROUND(100.0 * a.signups / NULLIF(a.runs, 0), 1),
    ROUND(100.0 * a.signups / NULLIF(a.unlock_intents, 0), 1)
  FROM tools t
  LEFT JOIN agg a ON a.tool = t.tool
  ORDER BY t.tool;
$$;

CREATE OR REPLACE FUNCTION public.admin_labs_recent_signups(p_limit integer DEFAULT 25)
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
  WHERE e.event = 'signup' AND e.is_bot = false AND e.email IS NOT NULL
  ORDER BY e.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 25), 200));
$$;

-- Lock to service_role only (EXECUTE defaults to PUBLIC). The admin page calls
-- these with the service client; anon/authenticated must not reach signup emails.
REVOKE EXECUTE ON FUNCTION public.admin_labs_funnel() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_labs_recent_signups(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_labs_funnel() TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_labs_recent_signups(integer) TO service_role;

-- DOWN
-- DROP FUNCTION IF EXISTS public.admin_labs_recent_signups(integer);
-- DROP FUNCTION IF EXISTS public.admin_labs_funnel();
