-- Migration 0118 — audit.log_provider_action_bulk + public wrapper
-- Date:    2026-05-11
-- Author:  Claude (Block C.2 proper-fix) on Charlotte's instruction
-- Reason:  bulkMarkOutcomeAction in app/app/provider/leads/[id]/actions.ts
--          previously processed each selected lead sequentially: one UPDATE
--          + one log_provider_action_v1 RPC per row. For 30 selected leads
--          that's 60 round-trips, ~3-6 seconds end-to-end. The proper fix
--          is one (or a small number of) UPDATE statements + one batched
--          audit RPC. This migration provides the batched audit writer;
--          the JS-side rewrite uses it.
--
--          Mirrors audit.log_provider_action (migration 0095) in every
--          respect (actor resolution, gate, append-only) but accepts a
--          JSONB array of entries and emits one INSERT. Each entry shape:
--            { target_table, target_id, before, after, context }
--          p_action is shared across all entries — that's the deliberate
--          shape (bulk = one logical action, many targets).
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: additive only. New function in audit, new public wrapper.
--      No table changes, no schema_version bump.
--   2. Readers affected: none (function is a writer).
--   3. Writers affected: bulkMarkOutcomeAction will adopt this in the
--      same session. No other current consumer.
--   4. Schema version: no payload contract.
--   5. Data migration: none.
--   6. Role/policy: GRANT EXECUTE TO authenticated on the public wrapper.
--      The inner function gates on active provider_users (same as 0095).
--   7. Rollback: DOWN drops both functions. Caller falls back to the
--      single-row RPC.
--   8. Sign-off: owner (this session, 2026-05-11).
-- Related: 0095 (single-row audit writer), 0106 (single-row public wrapper),
--          C.2 of the May 11 portal audit redo.

BEGIN;

-- =============================================================================
-- 1. Inner SECURITY DEFINER writer (audit schema, not exposed via Data API)
-- =============================================================================

CREATE OR REPLACE FUNCTION audit.log_provider_action_bulk(
  p_action  TEXT,
  p_entries JSONB
)
RETURNS BIGINT[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit, crm, public
AS $$
DECLARE
  v_actor_user_id     UUID;
  v_actor_email       TEXT;
  v_actor_provider_id TEXT;
  v_user_status       TEXT;
  v_ids               BIGINT[];
BEGIN
  IF p_action IS NULL OR length(trim(p_action)) = 0 THEN
    RAISE EXCEPTION 'Action is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION 'Entries must be a JSONB array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF jsonb_array_length(p_entries) = 0 THEN
    -- Empty batch is a no-op; return empty array rather than erroring so
    -- callers can pass an unfiltered batch and let the function decide.
    RETURN ARRAY[]::BIGINT[];
  END IF;

  v_actor_user_id := auth.uid();
  v_actor_email   := auth.jwt() ->> 'email';

  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Provider audit writes require an authenticated user (auth.uid was NULL)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT provider_id, status
    INTO v_actor_provider_id, v_user_status
    FROM crm.provider_users
   WHERE auth_user_id = v_actor_user_id
   LIMIT 1;

  IF v_actor_provider_id IS NULL THEN
    RAISE EXCEPTION 'Caller % is not a registered provider user', v_actor_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_user_status <> 'active' THEN
    RAISE EXCEPTION 'Provider user % is not active (status=%); bulk audit write rejected',
      v_actor_user_id, v_user_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  WITH inserts AS (
    INSERT INTO audit.actions (
      actor_user_id, actor_email, surface, action,
      target_table, target_id, before_value, after_value, context
    )
    SELECT
      v_actor_user_id,
      v_actor_email,
      'provider',
      p_action,
      NULLIF(entry->>'target_table', ''),
      NULLIF(entry->>'target_id', ''),
      entry->'before',
      entry->'after',
      COALESCE(entry->'context', '{}'::jsonb)
        || jsonb_build_object('actor_provider_id', v_actor_provider_id)
    FROM jsonb_array_elements(p_entries) AS entry
    RETURNING id
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::BIGINT[])
    INTO v_ids
    FROM inserts;

  RETURN v_ids;
END;
$$;

COMMENT ON FUNCTION audit.log_provider_action_bulk(TEXT, JSONB) IS
  'Batched sibling of audit.log_provider_action(). Accepts a JSONB array of {target_table, target_id, before, after, context} entries, all under one shared action name. One INSERT, one actor-resolution. Append-only; only write path for batched provider actions. Added migration 0118.';

REVOKE ALL ON FUNCTION audit.log_provider_action_bulk(TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.log_provider_action_bulk(TEXT, JSONB) TO authenticated;

-- =============================================================================
-- 2. Public wrapper exposed via the Data API
-- =============================================================================

CREATE OR REPLACE FUNCTION public.log_provider_action_bulk_v1(
  p_action  TEXT,
  p_entries JSONB
)
RETURNS BIGINT[]
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, audit, public
AS $$
  SELECT audit.log_provider_action_bulk(p_action, p_entries);
$$;

COMMENT ON FUNCTION public.log_provider_action_bulk_v1(TEXT, JSONB) IS
  'Public-schema wrapper over audit.log_provider_action_bulk(). Same versioning convention as log_provider_action_v1 (0106). Added migration 0118.';

REVOKE ALL ON FUNCTION public.log_provider_action_bulk_v1(TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_provider_action_bulk_v1(TEXT, JSONB) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION public.log_provider_action_bulk_v1(TEXT, JSONB) FROM authenticated;
-- DROP FUNCTION IF EXISTS public.log_provider_action_bulk_v1(TEXT, JSONB);
-- REVOKE EXECUTE ON FUNCTION audit.log_provider_action_bulk(TEXT, JSONB) FROM authenticated;
-- DROP FUNCTION IF EXISTS audit.log_provider_action_bulk(TEXT, JSONB);
-- COMMIT;
