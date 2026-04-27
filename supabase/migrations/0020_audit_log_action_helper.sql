-- Migration 0020 — audit.log_action() helper for dashboard write surfaces
-- Date: 2026-04-25
-- Author: Claude (platform Session D start) with owner sign-off
-- Reason: Session D ships write surfaces — enrolment outcome, lead routing,
--         provider edit, error replay. Every one of those writes needs to
--         record an audit row in `audit.actions`. Per Option A picked in
--         Session 9 scoping: a single SECURITY DEFINER helper function is
--         the only thing allowed to INSERT into audit.actions. Append-only
--         enforced at the function layer rather than in every Server Action.
--
--         Why not direct INSERT with append-only RLS: append-only RLS
--         (deny UPDATE + DELETE, allow INSERT to anyone) is fine but spreads
--         "what counts as a valid audit row" across every caller. The
--         helper centralises the schema, the actor lookup, and any future
--         enrichments (IP, user-agent, request-id correlation).
--
--         The audit.actions table:
--         - Already has SELECT policy for readonly_analytics (migration 0016)
--         - Has NO INSERT/UPDATE/DELETE policies — RLS denies all
--         - This SECURITY DEFINER function is the only write path
--
--         Function signature, plain English:
--           audit.log_action(action, target_table?, target_id?,
--                            before?, after?, context?, surface?)
--           -> returns the new audit.actions.id
--
--         It pulls actor_user_id from auth.uid() and actor_email from the
--         JWT email claim. Both come from the Supabase client's logged-in
--         session (Charlotte's MFA login on admin.switchleads.co.uk).
--
--         For system-written actions (cron jobs, Edge Functions running
--         without a user JWT), a separate helper will be added later when
--         Session D auto-flip cron needs it. This one is admin-surface only.
--
-- Related: platform/docs/admin-dashboard-scoping.md § Session D,
--          platform/supabase/migrations/0016_session_c_schema_additions.sql
--          (the audit.actions table itself).

-- UP

-- =============================================================================
-- 1. The helper
-- =============================================================================

CREATE OR REPLACE FUNCTION audit.log_action(
  p_action        TEXT,
  p_target_table  TEXT DEFAULT NULL,
  p_target_id     TEXT DEFAULT NULL,
  p_before        JSONB DEFAULT NULL,
  p_after         JSONB DEFAULT NULL,
  p_context       JSONB DEFAULT NULL,
  p_surface       TEXT DEFAULT 'admin'
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit, public
AS $$
DECLARE
  v_actor_user_id UUID;
  v_actor_email   TEXT;
  v_new_id        BIGINT;
BEGIN
  -- Validate surface up front. The table CHECK constraint catches this too,
  -- but failing here gives a clearer error message back to the Server Action.
  IF p_surface NOT IN ('admin', 'provider', 'system') THEN
    RAISE EXCEPTION 'Invalid surface %: must be one of admin, provider, system', p_surface
      USING ERRCODE = 'check_violation';
  END IF;

  -- Action is required and free-form. Convention: snake_case verb_noun, e.g.
  -- 'route_lead', 'mark_enrolment_outcome', 'edit_provider', 'replay_error'.
  IF p_action IS NULL OR length(trim(p_action)) = 0 THEN
    RAISE EXCEPTION 'Action is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  -- Pull actor identity from the JWT context that Supabase sets on
  -- authenticated requests. For admin surface, both must be present —
  -- Charlotte's session always carries them.
  v_actor_user_id := auth.uid();
  v_actor_email   := auth.jwt() ->> 'email';

  IF p_surface = 'admin' AND (v_actor_user_id IS NULL OR v_actor_email IS NULL) THEN
    RAISE EXCEPTION 'Admin-surface audit writes require an authenticated user (auth.uid + email). Got user_id=% email=%', v_actor_user_id, v_actor_email
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Provider and system surfaces: not yet wired (Phase 4 + Session D
  -- auto-flip cron). Block them here so we don't accidentally allow
  -- unauthenticated writes through this helper.
  IF p_surface IN ('provider', 'system') THEN
    RAISE EXCEPTION 'Surface % is not yet wired into audit.log_action(). Add a dedicated helper or extend this one when the consumer ships.', p_surface
      USING ERRCODE = 'feature_not_supported';
  END IF;

  INSERT INTO audit.actions (
    actor_user_id, actor_email, surface, action,
    target_table, target_id, before_value, after_value, context
  ) VALUES (
    v_actor_user_id, v_actor_email, p_surface, p_action,
    p_target_table, p_target_id, p_before, p_after, p_context
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

COMMENT ON FUNCTION audit.log_action(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, TEXT) IS
  'The only write path into audit.actions. Pulls actor identity from auth.uid()/auth.jwt() so callers do not pass it. Append-only enforced at function level: there is no UPDATE or DELETE counterpart and no INSERT policy on audit.actions. Provider and system surfaces are blocked until dedicated helpers ship.';

-- =============================================================================
-- 2. Grants
-- =============================================================================
-- authenticated: Supabase role assigned to logged-in users on the dashboard
--                (Charlotte today, future admin team members tomorrow). The
--                admin RLS allowlist (admin.is_admin() from migration 0014)
--                gates which authenticated users can actually trigger writes
--                via the Server Actions layer.

REVOKE ALL ON FUNCTION audit.log_action(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.log_action(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, TEXT) TO authenticated;

-- DOWN
-- REVOKE EXECUTE ON FUNCTION audit.log_action(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, TEXT) FROM authenticated;
-- DROP FUNCTION IF EXISTS audit.log_action(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, TEXT);
