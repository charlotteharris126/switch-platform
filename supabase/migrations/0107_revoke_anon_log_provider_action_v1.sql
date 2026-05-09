-- Migration 0107 — revoke anon EXECUTE on public.log_provider_action_v1
-- Date:    2026-05-09
-- Author:  Claude (platform Session 38) on Charlotte's instruction
-- Reason:  Migration 0106 added public.log_provider_action_v1 with
--          REVOKE FROM PUBLIC + GRANT to authenticated. That wasn't enough:
--          the Supabase project carries ALTER DEFAULT PRIVILEGES IN SCHEMA
--          public GRANT EXECUTE ON FUNCTIONS TO {anon, authenticated,
--          service_role}, so any new public function picks up those grants
--          on creation regardless of REVOKE FROM PUBLIC (which only acts on
--          the literal `public` pseudo-role, not the named ones).
--
--          Functionally the wrapper was already locked down — the inner
--          audit.log_provider_action raises 'insufficient_privilege' when
--          auth.uid() is NULL, so anon callers can't write rows. But
--          defence-in-depth and visible least-privilege wins:
--            - anon shouldn't be able to introspect/probe the function
--            - the public ACL should match intent
--          service_role is left granted: consistent with the inner function
--          (0095 didn't revoke service_role either) and harmless because
--          service_role JWTs carry no auth.uid() so the inner gate still
--          rejects.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: REVOKE EXECUTE FROM anon on the wrapper. No table changes,
--      no data migration.
--   2. Readers/writers: no caller currently runs as anon, so no breakage.
--   3. Schema version: not affected.
--   4. Rollback: GRANT EXECUTE TO anon to restore the prior ACL.
--   5. Sign-off: owner (this session, 2026-05-09).
-- Related: 0106 (wrapper), 0095 (inner function).

-- UP

REVOKE EXECUTE ON FUNCTION public.log_provider_action_v1(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB) FROM anon;

-- DOWN
-- GRANT EXECUTE ON FUNCTION public.log_provider_action_v1(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB) TO anon;
