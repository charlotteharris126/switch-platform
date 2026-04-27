-- Migration 0015 — revoke public.vw_cron_jobs + public.vw_cron_runs from API-exposed roles
-- Date: 2026-04-24
-- Author: Claude (platform Session B) with owner review
-- Reason: When enabling the Supabase Data API so admin.switchleads.co.uk can read leads/crm,
--         Supabase's security scanner flagged vw_cron_jobs + vw_cron_runs as "insecure" because
--         they run with SECURITY DEFINER (security_invoker = false). They must stay that way —
--         migration 0008 explicitly set security_invoker = false so that `readonly_analytics`
--         (Sasha, Mira, Iris via MCP) can read them without holding cron.* permissions.
--         The safe fix is to make sure the API roles (anon, authenticated) have no SELECT on
--         these views, so even with the Data API enabled on the public schema the views are
--         not queryable. readonly_analytics retains its grant (and goes via direct Postgres
--         connection, not via the API).
-- Related: platform/supabase/migrations/0008_cron_view_redact_command.sql,
--          platform/docs/admin-dashboard-scoping.md Session B.

-- UP

REVOKE ALL ON public.vw_cron_jobs  FROM anon, authenticated, public;
REVOKE ALL ON public.vw_cron_runs  FROM anon, authenticated, public;

-- Re-assert the readonly_analytics grants (idempotent — migration 0007/0008 already granted).
GRANT SELECT ON public.vw_cron_jobs  TO readonly_analytics;
GRANT SELECT ON public.vw_cron_runs  TO readonly_analytics;

-- DOWN
-- GRANT SELECT ON public.vw_cron_jobs  TO anon, authenticated;
-- GRANT SELECT ON public.vw_cron_runs  TO anon, authenticated;
-- (But don't. These views expose cron metadata that API-role users should not read.)
