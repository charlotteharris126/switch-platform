-- Migration 0095 — audit.log_provider_action() helper for the provider portal
-- Date:    2026-05-09
-- Author:  Claude (platform Session 36) on Charlotte's instruction
-- Reason:  Sibling to audit.log_action() (migration 0020, admin surface) and
--          audit.log_system_action() (migration 0023, cron surface). This is
--          the only write path into audit.actions for actions originating
--          from the provider portal at app.switchleads.co.uk.
--
--          Why separate helper instead of extending audit.log_action():
--          provider auth context differs from admin auth. Admin validates
--          via admin.is_admin() (gate applied in RLS layer). Provider
--          validates by confirming the caller's auth.uid() has a row in
--          crm.provider_users with status='active'. Different validation =
--          different function, keeps the admin path stable and the provider
--          path self-contained. App code calls the right one for the
--          surface; both go to the same table, same audit chain.
--
--          Function pulls:
--            - actor_user_id from auth.uid() (Supabase session)
--            - actor_email   from auth.jwt() ->> 'email'
--            - actor_provider_id from crm.provider_users (lookup by auth.uid)
--          Surface is hard-coded 'provider' (caller cannot impersonate admin
--          or system).
--
--          Append-only enforced same way as the admin helper: no UPDATE
--          or DELETE counterpart, no INSERT policy on audit.actions, this
--          SECURITY DEFINER function is the only write path.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: additive only. New function. No table changes, no data
--      migration. audit.actions schema already permits surface='provider'
--      (CHECK from migration 0016/0020).
--   2. Readers affected: none yet. Future readers: admin dashboard provider-
--      side audit panel on /admin/leads/[id], dispute defence queries.
--   3. Writers affected: future portal Server Actions (mark_outcome,
--      view_lead, fire_chaser, invite_user, etc.) — none ship in this migration.
--   4. Schema version: no payload contract.
--   5. Data migration: none.
--   6. Role/policy: GRANT EXECUTE to authenticated. The function self-
--      validates that the caller has a provider_users row. Provider_user
--      Postgres role (created in 0096) gets the same grant in that migration.
--   7. Rollback: DOWN drops the function. No external dependencies until
--      the portal Server Actions ship.
--   8. Sign-off: owner (this session, 2026-05-08/09).
-- Related: migration 0020 (admin helper), 0023 (system helper), 0094
--          (provider_users table), platform/docs/provider-portal-mvp-scoping.md

-- UP

CREATE OR REPLACE FUNCTION audit.log_provider_action(
  p_action        TEXT,
  p_target_table  TEXT DEFAULT NULL,
  p_target_id     TEXT DEFAULT NULL,
  p_before        JSONB DEFAULT NULL,
  p_after         JSONB DEFAULT NULL,
  p_context       JSONB DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit, crm, public
AS $$
DECLARE
  v_actor_user_id     UUID;
  v_actor_email       TEXT;
  v_actor_provider_id TEXT;
  v_user_status       TEXT;
  v_new_id            BIGINT;
BEGIN
  -- Required action.
  IF p_action IS NULL OR length(trim(p_action)) = 0 THEN
    RAISE EXCEPTION 'Action is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  -- Pull caller identity from the JWT.
  v_actor_user_id := auth.uid();
  v_actor_email   := auth.jwt() ->> 'email';

  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Provider audit writes require an authenticated user (auth.uid was NULL)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Confirm the caller is an active provider_users row. This is the only
  -- gate — RLS on the table ensures non-admin authenticated users can only
  -- SELECT their own row anyway (policy ships in 0096).
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
    RAISE EXCEPTION 'Provider user % is not active (status=%); audit write rejected',
      v_actor_user_id, v_user_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Stamp last_login_at as a side-effect of action logging? No — that's
  -- the auth callback's job, kept separate so a stale session doesn't
  -- masquerade as a fresh login. Leave last_login_at to the auth path.

  INSERT INTO audit.actions (
    actor_user_id, actor_email, surface, action,
    target_table, target_id, before_value, after_value,
    context
  ) VALUES (
    v_actor_user_id, v_actor_email, 'provider', p_action,
    p_target_table, p_target_id, p_before, p_after,
    -- Inject actor_provider_id into the context JSONB so audit consumers
    -- can attribute actions to providers without joining crm.provider_users.
    -- If the caller passed context, merge; otherwise create a fresh object.
    coalesce(p_context, '{}'::jsonb) || jsonb_build_object('actor_provider_id', v_actor_provider_id)
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

COMMENT ON FUNCTION audit.log_provider_action(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB) IS
  'The only write path into audit.actions for surface=''provider''. Pulls actor identity from auth.uid()/auth.jwt() and looks up the actor_provider_id from crm.provider_users. Append-only enforced at function level. Sibling to audit.log_action (admin) and audit.log_system_action (system/cron). Added migration 0095.';

REVOKE ALL ON FUNCTION audit.log_provider_action(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.log_provider_action(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB) TO authenticated;

-- The provider_user Postgres role gets EXECUTE granted in migration 0096
-- when the role is created.

-- DOWN
-- REVOKE EXECUTE ON FUNCTION audit.log_provider_action(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB) FROM authenticated;
-- DROP FUNCTION IF EXISTS audit.log_provider_action(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB);
