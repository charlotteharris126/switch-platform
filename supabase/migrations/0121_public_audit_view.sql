-- Migration 0121 — public.vw_audit_actions view over audit.actions
-- Date: 2026-05-12
-- Author: Claude on Charlotte's instruction
-- Reason:
--   audit.actions sits in the audit schema, which has to be added to
--   Supabase Data API "Exposed schemas" before supabase-js can query it
--   via .schema("audit"). The setting is flaky — even after adding +
--   saving + reloading PostgREST schema cache, the audit page still
--   throws "Invalid schema: audit".
--
--   Working around this with a public.vw_audit_actions view. The view
--   sits in public (which IS always exposed) and SELECTs over
--   audit.actions. Admin client (service_role) can read everything via
--   the view; readonly_analytics keeps its existing SELECT on
--   audit.actions directly.
--
--   No security regression: the view doesn't grant any new access —
--   only the same SELECT that service_role + readonly_analytics
--   already have on audit.actions.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: additive only. New view in public.
--   2. Readers: /admin/audit (removed) + /admin/providers/[id]/audit +
--      /admin/leads/[id] now read this view rather than audit.actions
--      directly.
--   3. Writers: none. View is read-only.
--   4. Schema version: no payload contract.
--   5. Data migration: none.
--   6. Role/policy: service_role + readonly_analytics SELECT.
--   7. Rollback: DROP VIEW.
--   8. Sign-off: owner (this session).

BEGIN;

CREATE OR REPLACE VIEW public.vw_audit_actions
WITH (security_invoker = true)
AS
SELECT
  id,
  created_at,
  actor_user_id,
  actor_email,
  surface,
  action,
  target_table,
  target_id,
  before_value,
  after_value,
  context,
  ip_address,
  user_agent
FROM audit.actions;

COMMENT ON VIEW public.vw_audit_actions IS
  'Public-schema mirror of audit.actions so admin pages can read audit history via the Data API without depending on the audit schema being in Supabase Exposed Schemas. security_invoker = true ensures the underlying audit.actions RLS / GRANTs still gate access. Added migration 0121.';

GRANT SELECT ON public.vw_audit_actions TO service_role;
GRANT SELECT ON public.vw_audit_actions TO readonly_analytics;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP VIEW IF EXISTS public.vw_audit_actions;
-- COMMIT;
