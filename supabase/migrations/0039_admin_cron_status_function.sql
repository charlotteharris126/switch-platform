-- Migration 0039 — admin.cron_status() function for the dashboard
-- Date: 2026-04-29
-- Author: Claude (platform session) with owner sign-off
-- Reason: The /admin/agents page (Tools section) needs to show whether
-- each agent's background automations are actually running. The data
-- lives in cron.job, exposed via public.vw_cron_jobs to readonly_analytics
-- only (per migration 0015's security cleanup). The dashboard runs as
-- the authenticated role with admin.is_admin() gating, which has no
-- direct read on vw_cron_jobs.
--
-- Solution mirrors the existing admin.is_admin() pattern from migration
-- 0014: a SECURITY DEFINER function that runs with elevated privileges,
-- gated at the function body by admin.is_admin(). Returns jobname,
-- schedule, active. Command column is deliberately omitted (still
-- contains plaintext secrets in some legacy crons — see 0008).
--
-- Why a function rather than re-granting the view: a function gives us
-- explicit per-call admin gating that survives Supabase's security
-- scanner (the prior re-grant attempt would re-trigger the false-positive
-- "view bypasses RLS" warning that 0015 cleaned up). The function path
-- also leaves a clean future expansion point if we want to add per-job
-- last-run-at, last-success, or fail-count columns later.
--
-- Related: 0007 (vw_cron_jobs creation), 0008 (command redaction),
-- 0014 (admin.is_admin pattern), 0015 (revoke from API roles),
-- platform/app/app/admin/agents/page.tsx (consumer).

-- UP

-- Lives in public so PostgREST exposes it via the default Data API schemas
-- (admin is internal and not auto-exposed). Gating at the function body via
-- admin.is_admin() keeps it admin-only regardless of who can call the RPC.
CREATE OR REPLACE FUNCTION public.admin_cron_status()
RETURNS TABLE (jobname TEXT, schedule TEXT, active BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, cron
AS $$
  SELECT j.jobname::text, j.schedule::text, j.active
    FROM cron.job j
   WHERE admin.is_admin()
   ORDER BY j.jobname;
$$;

REVOKE ALL ON FUNCTION public.admin_cron_status() FROM public;
GRANT EXECUTE ON FUNCTION public.admin_cron_status() TO authenticated;

-- DOWN
-- DROP FUNCTION IF EXISTS public.admin_cron_status();
