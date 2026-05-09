-- Migration 0106 — public.log_provider_action_v1: thin wrapper over audit.log_provider_action
-- Date:    2026-05-09
-- Author:  Claude (platform Session 38) on Charlotte's instruction
-- Reason:  Provider portal Server Actions (mark_outcome, future view_lead /
--          fire_chaser / etc.) need a way to write into audit.actions. The
--          underlying writer audit.log_provider_action() lives in the audit
--          schema (migration 0095), which is intentionally not exposed via
--          the Supabase Data API — supabase-js .rpc() only sees functions
--          in exposed schemas (public + others added in Project Settings →
--          Data API → Exposed schemas). Two options to bridge:
--            (a) expose audit + grant service_role on it
--            (b) add a public-schema wrapper that delegates
--          Option (b) chosen: keeps the audit schema closed (only the
--          allowlisted writers in it can be called) and gives us a stable
--          public surface to deprecate without dragging the schema with it.
--          Versioned name (v1) leaves head-room: if we ever change the
--          wrapper shape we ship _v2 and retire _v1 with a deprecation
--          window per .claude/rules/data-infrastructure.md §12.
--
--          The wrapper is SECURITY INVOKER (default). The inner function is
--          SECURITY DEFINER; it reads auth.uid() / auth.jwt() from the
--          per-request GUC `request.jwt.claims`, which Supabase-Auth-via-
--          PostgREST sets at the start of every request. That GUC stays
--          set across nested function calls, so identity flows through.
--
--          Important: the inner function itself enforces "must be active
--          provider_users row" (migration 0095). The wrapper performs no
--          additional gate. Defence-in-depth still holds: GRANT EXECUTE
--          on the wrapper goes to authenticated only (not anon), the
--          inner function's gate rejects authenticated-but-not-provider
--          callers, and RLS on audit.actions has no INSERT policy at all
--          (the SECURITY DEFINER inner function is the only write path).
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: additive only. New function in public. No table changes,
--      no data migration, no policy changes.
--   2. Readers affected: none.
--   3. Writers affected: portal Server Actions can now reach the audit
--      writer via supabase-js .rpc('log_provider_action_v1', ...). First
--      consumer is markOutcomeAction in
--      app/app/provider/leads/[id]/actions.ts (this session).
--   4. Schema version: no payload contract.
--   5. Data migration: none.
--   6. Role/policy: GRANT EXECUTE TO authenticated. No change to inner
--      function or audit.actions policies.
--   7. Rollback: DOWN drops the wrapper. Audit writes break for any
--      caller that has migrated; revert markOutcomeAction at the same
--      time or expose audit schema as fallback.
--   8. Sign-off: owner (this session, 2026-05-09).
-- Related: 0095 (inner function), 0096 (provider RLS policies),
--          accounts-legal/docs/current-handoff.md item 2 (Clara's three
--          gating conditions for EMS cutover — this clears condition 1).

-- UP

CREATE OR REPLACE FUNCTION public.log_provider_action_v1(
  p_action        TEXT,
  p_target_table  TEXT DEFAULT NULL,
  p_target_id     TEXT DEFAULT NULL,
  p_before        JSONB DEFAULT NULL,
  p_after         JSONB DEFAULT NULL,
  p_context       JSONB DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, audit, public
AS $$
  SELECT audit.log_provider_action(
    p_action, p_target_table, p_target_id, p_before, p_after, p_context
  );
$$;

COMMENT ON FUNCTION public.log_provider_action_v1(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB) IS
  'Public-schema delegating wrapper over audit.log_provider_action(). Exists only because the audit schema is not exposed via the Supabase Data API. SECURITY INVOKER — auth identity flows through to the inner SECURITY DEFINER writer, which gates on crm.provider_users active+portal_enabled. Versioned (_v1) for forward compatibility per data-infrastructure.md §12. Added migration 0106.';

REVOKE ALL ON FUNCTION public.log_provider_action_v1(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_provider_action_v1(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB) TO authenticated;

-- DOWN
-- REVOKE EXECUTE ON FUNCTION public.log_provider_action_v1(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB) FROM authenticated;
-- DROP FUNCTION IF EXISTS public.log_provider_action_v1(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB);
