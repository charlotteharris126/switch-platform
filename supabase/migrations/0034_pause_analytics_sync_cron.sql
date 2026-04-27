-- Migration 0034 — Pause social-analytics-sync cron
-- Date: 2026-04-27
-- Author: Claude (platform Session 13) with owner sign-off
-- Reason: Migration 0033 scheduled the analytics-sync cron daily at 04:00 UTC.
--         Subsequent OAuth reconnect on 2026-04-27 revealed that
--         `r_member_social` (the scope the analytics-sync function depends on)
--         is NOT auto-granted on the Share on LinkedIn tier — LinkedIn
--         returned `unauthorized_scope_error` on the reconnect dance. The
--         scope is gated behind Marketing Developer Platform approval, which
--         is in flight but won't land for 2-8 weeks.
--
--         Running the cron now would invoke the function daily, the function
--         would 401/403 on the first post, and `auth_reconnect_required` would
--         be set in the response — every day, indefinitely. No data captured,
--         compute burned, audit rows multiplied with no value.
--
--         Cleaner: pause the cron entirely. Re-enable in a forward migration
--         once MDP approval lands and Charlotte reconnects with the new scope.
--         The Edge Function code itself is unchanged and ready for that day.
--
-- Related: platform/supabase/migrations/0033_social_analytics_sync_cron.sql
--          (the schedule we are pausing),
--          platform/supabase/functions/social-analytics-sync/index.ts (the
--          function — left in place, untouched).

-- UP

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'social-analytics-sync-daily') THEN
    PERFORM cron.unschedule('social-analytics-sync-daily');
  END IF;
END $$;

-- DOWN
-- -- Re-enable when r_member_social is granted on the LinkedIn app:
-- SELECT cron.schedule(
--   'social-analytics-sync-daily',
--   '0 4 * * *',
--   $cmd$
--     SELECT net.http_post(
--       url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/social-analytics-sync',
--       headers := jsonb_build_object(
--         'x-audit-key', public.get_shared_secret('AUDIT_SHARED_SECRET'),
--         'content-type', 'application/json'
--       ),
--       body := '{}'::jsonb,
--       timeout_milliseconds := 60000
--     );
--   $cmd$
-- );
