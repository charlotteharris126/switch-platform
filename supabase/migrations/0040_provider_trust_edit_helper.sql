-- Migration 0040 — Provider trust edit helper
-- Date: 2026-04-29
-- Author: Claude (platform session) with owner sign-off (no-patchwork rule)
-- Reason: Migration 0038 moved provider marketing content (trust_line,
-- funding_types, regions, voice_notes) into crm.providers. The
-- /new-course-page skill (and any future trust-content edit) needs a
-- proper write path that doesn't require Charlotte to paste raw SQL.
-- Same SECURITY DEFINER + admin.is_admin() + audit pattern as
-- crm.update_provider (migration 0024) but scoped to the four trust
-- columns only — keeps the form surface focused and prevents the trust
-- edit path from drifting into operational fields.
--
-- Validates funding_types values are in the allowed set (gov / self / loan).
-- Defends the column at write time so the dashboard can pass a typo through
-- and get a clean error rather than a silent garbage row.

-- UP

CREATE OR REPLACE FUNCTION crm.update_provider_trust(
  p_provider_id    TEXT,
  p_trust_line     TEXT,
  p_funding_types  TEXT[],
  p_regions        TEXT[],
  p_voice_notes    TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm, audit, admin, public
AS $$
DECLARE
  v_existing crm.providers%ROWTYPE;
  v_before   JSONB;
  v_after    JSONB;
  v_invalid  TEXT;
BEGIN
  IF NOT admin.is_admin() THEN
    RAISE EXCEPTION 'Only admins can edit provider trust content'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_provider_id IS NULL OR length(trim(p_provider_id)) = 0 THEN
    RAISE EXCEPTION 'provider_id is required' USING ERRCODE = 'not_null_violation';
  END IF;

  -- Validate funding_types entries — typo-defence at the DB layer.
  IF p_funding_types IS NOT NULL THEN
    SELECT ft
      INTO v_invalid
      FROM unnest(p_funding_types) AS ft
     WHERE ft NOT IN ('gov', 'self', 'loan')
     LIMIT 1;
    IF v_invalid IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid funding_type: %, allowed values are gov / self / loan', v_invalid
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT *
    INTO v_existing
    FROM crm.providers
   WHERE provider_id = p_provider_id
   LIMIT 1;

  IF v_existing.provider_id IS NULL THEN
    RAISE EXCEPTION 'Provider % not found', p_provider_id USING ERRCODE = 'no_data_found';
  END IF;

  v_before := jsonb_build_object(
    'trust_line',    v_existing.trust_line,
    'funding_types', to_jsonb(v_existing.funding_types),
    'regions',       to_jsonb(v_existing.regions),
    'voice_notes',   v_existing.voice_notes
  );

  UPDATE crm.providers
     SET trust_line    = p_trust_line,
         funding_types = p_funding_types,
         regions       = p_regions,
         voice_notes   = p_voice_notes,
         updated_at    = now()
   WHERE provider_id = p_provider_id;

  v_after := jsonb_build_object(
    'trust_line',    p_trust_line,
    'funding_types', to_jsonb(p_funding_types),
    'regions',       to_jsonb(p_regions),
    'voice_notes',   p_voice_notes
  );

  PERFORM audit.log_action(
    p_action       := 'edit_provider_trust',
    p_target_table := 'crm.providers',
    p_target_id    := p_provider_id,
    p_before       := v_before,
    p_after        := v_after,
    p_surface      := 'admin'
  );
END;
$$;

COMMENT ON FUNCTION crm.update_provider_trust(TEXT, TEXT, TEXT[], TEXT[], TEXT) IS
  'Edit provider marketing content (trust_line, funding_types, regions, voice_notes) from the admin dashboard. Atomic: validates, updates, writes audit row. Scoped to the four trust columns only — operational fields go through crm.update_provider. Added migration 0040.';

REVOKE ALL ON FUNCTION crm.update_provider_trust(TEXT, TEXT, TEXT[], TEXT[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.update_provider_trust(TEXT, TEXT, TEXT[], TEXT[], TEXT) TO authenticated;

-- DOWN
-- REVOKE EXECUTE ON FUNCTION crm.update_provider_trust(TEXT, TEXT, TEXT[], TEXT[], TEXT) FROM authenticated;
-- DROP FUNCTION IF EXISTS crm.update_provider_trust(TEXT, TEXT, TEXT[], TEXT[], TEXT);
