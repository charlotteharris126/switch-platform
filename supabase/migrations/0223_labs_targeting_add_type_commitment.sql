-- Migration 0223 — extend admin_labs_targeting with business type and commitment
-- Date: 2026-06-27
-- Author: Claude (Labs session)
-- Reason: Surface top business type preferences and commitment choices in the admin Labs page.

-- UP
CREATE OR REPLACE FUNCTION public.admin_labs_targeting(p_tool text DEFAULT 'gaply'::text)
RETURNS TABLE(category text, value text, cnt bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
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

  UNION ALL

  -- Business type (array)
  SELECT 'type'::text, t.val, count(*)::bigint
  FROM labs.events e,
       jsonb_array_elements_text(e.payload->'prefs'->'type') AS t(val)
  WHERE e.tool = p_tool AND e.event = 'run' AND e.is_bot = false
    AND jsonb_typeof(e.payload->'prefs'->'type') = 'array'
  GROUP BY t.val

  UNION ALL

  -- Commitment preference (array)
  SELECT 'commitment'::text, c.val, count(*)::bigint
  FROM labs.events e,
       jsonb_array_elements_text(e.payload->'prefs'->'commitment') AS c(val)
  WHERE e.tool = p_tool AND e.event = 'run' AND e.is_bot = false
    AND jsonb_typeof(e.payload->'prefs'->'commitment') = 'array'
  GROUP BY c.val

  ORDER BY 1, 3 DESC;
$function$;

-- DOWN
-- Re-run the previous version of admin_labs_targeting (without type and commitment unions).
