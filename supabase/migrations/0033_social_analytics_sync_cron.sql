-- Migration 0033 — Schedule social-analytics-sync cron (Session G.4)
-- Date: 2026-04-27
-- Author: Claude (platform Session 12) with owner sign-off
-- Reason: The social-analytics-sync Edge Function reads reaction / comment /
--         share counts from LinkedIn for every published post in the last
--         30 days, writing fresh time-series snapshots into
--         social.post_analytics. Daily cadence is enough — LinkedIn rate-
--         limits aggressive polling and engagement counts on personal posts
--         change slowly after the first 24 hours.
--
--         04:00 UTC chosen because: posts publish through the day in BST
--         (mostly 8-10 UTC for the morning slots); a 04:00 sync gives a
--         clean overnight snapshot of the previous day's posts plus any
--         older posts still accruing engagement.
--
-- Related: platform/supabase/migrations/0031_social_oauth_token_read_helper.sql
--          (token-read helper used by the function),
--          platform/supabase/functions/social-analytics-sync/index.ts.

-- UP

-- Idempotent: unschedule any existing job with this name first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'social-analytics-sync-daily') THEN
    PERFORM cron.unschedule('social-analytics-sync-daily');
  END IF;
END $$;

SELECT cron.schedule(
  'social-analytics-sync-daily',
  '0 4 * * *',
  $cmd$
    SELECT net.http_post(
      url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/social-analytics-sync',
      headers := jsonb_build_object(
        'x-audit-key', public.get_shared_secret('AUDIT_SHARED_SECRET'),
        'content-type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cmd$
);

-- DOWN
-- SELECT cron.unschedule('social-analytics-sync-daily');
