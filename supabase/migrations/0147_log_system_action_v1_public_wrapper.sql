-- Migration 0147 — public.log_system_action_v1 wrapper
-- Date: 2026-05-18
-- Author: Sasha (platform Session 51) with owner review
-- Reason: System-context audit events (e.g. provider-set-password invite
-- acceptance) need a public-schema RPC so the Next.js admin client can
-- write to audit.actions. The audit schema isn't exposed via the
-- Supabase Data API, and audit.actions has no INSERT grant — only
-- SELECT for readonly_analytics. Without a wrapper, the admin client's
-- direct `.from("actions").insert(...)` is silently rejected by RLS
-- (the try/catch in the Next.js action swallows the error).
--
-- Mirror of public.log_provider_action_v1 from migration 0106. SECURITY
-- INVOKER on the public side so the caller's auth context flows through;
-- audit.log_system_action is itself SECURITY DEFINER so the actual
-- INSERT runs with audit-owner privileges regardless of caller.
--
-- Bit Riverside 2026-05-18 (Freya Kelly) AND EMS 2026-05-18 (George
-- Taylor): both completed invite-claim post-deploy of e4e98b4, neither
-- got an audit row. Charlotte manually backfilled Freya; George being
-- the second occurrence triggered the proper fix.
-- Related: /provider-set-password/[token]/actions.ts

-- UP
CREATE OR REPLACE FUNCTION public.log_system_action_v1(
  p_actor        TEXT,
  p_action       TEXT,
  p_target_table TEXT  DEFAULT NULL,
  p_target_id    TEXT  DEFAULT NULL,
  p_before       JSONB DEFAULT NULL,
  p_after        JSONB DEFAULT NULL,
  p_context      JSONB DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE sql
SET search_path TO 'pg_catalog', 'audit', 'public'
AS $function$
  SELECT audit.log_system_action(
    p_actor, p_action, p_target_table, p_target_id, p_before, p_after, p_context
  );
$function$;

COMMENT ON FUNCTION public.log_system_action_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB) IS
  'Public-schema delegating wrapper over audit.log_system_action(). Exists because the audit schema is not exposed via the Supabase Data API. SECURITY INVOKER — auth identity flows through; the inner audit.log_system_action is SECURITY DEFINER and does the actual INSERT with audit-owner privileges. Use for system events with no authenticated user context (invite acceptance, cron-driven state transitions). Versioned (_v1) for forward compatibility per data-infrastructure.md §12. Added migration 0147.';

-- Public schema functions are callable by authenticated + service_role
-- by default in Supabase. No additional GRANT needed.

-- DOWN
-- DROP FUNCTION public.log_system_action_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB);
