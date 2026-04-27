-- Migration 0021 — public.log_action wrapper for API exposure
-- Date: 2026-04-25
-- Author: Claude (platform Session D start) with owner sign-off
-- Reason: Migration 0020 created `audit.log_action(...)` but the `audit`
--         schema is not exposed in the Supabase Data API (Session 8 only
--         exposed `leads` + `crm`). Server Actions calling
--         `supabase.schema("audit").rpc("log_action")` would fail at the
--         PostgREST layer.
--
--         Two options: (a) expose `audit` schema to the Data API — opens
--         the door to future audit tables/functions being callable via
--         REST; or (b) create a thin `public.log_action(...)` wrapper that
--         delegates to `audit.log_action(...)`.
--
--         Going with (b). Keeps the audit schema locked down (only
--         `readonly_analytics` SELECT + this SECURITY DEFINER write path).
--         The wrapper is a one-line SQL function — no logic of its own,
--         just argument forwarding.
--
-- Related: platform/supabase/migrations/0020_audit_log_action_helper.sql

-- UP

CREATE OR REPLACE FUNCTION public.log_action(
  p_action        TEXT,
  p_target_table  TEXT DEFAULT NULL,
  p_target_id     TEXT DEFAULT NULL,
  p_before        JSONB DEFAULT NULL,
  p_after         JSONB DEFAULT NULL,
  p_context       JSONB DEFAULT NULL,
  p_surface       TEXT DEFAULT 'admin'
)
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, audit, public
AS $$
  SELECT audit.log_action(p_action, p_target_table, p_target_id, p_before, p_after, p_context, p_surface);
$$;

COMMENT ON FUNCTION public.log_action(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, TEXT) IS
  'API-exposed wrapper around audit.log_action(). Identical signature, delegates straight through. Exists because audit schema is not in Data API exposed_schemas — keeping it locked down means no audit table is queryable via REST. Server Actions call this via supabase.rpc("log_action", ...). Added migration 0021.';

REVOKE ALL ON FUNCTION public.log_action(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_action(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, TEXT) TO authenticated;

-- DOWN
-- REVOKE EXECUTE ON FUNCTION public.log_action(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, TEXT) FROM authenticated;
-- DROP FUNCTION IF EXISTS public.log_action(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, TEXT);
