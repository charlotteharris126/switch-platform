-- Migration 0032 — Schedule social-publish cron (Session G.3)
-- Date: 2026-04-27
-- Author: Claude (platform Session 12) with owner sign-off
-- Reason: The social-publish Edge Function reads approved drafts ready to
--         publish and posts them to LinkedIn. Per the spec it runs on a
--         15-min cadence — frequent enough that scheduled posts land within
--         minutes of their scheduled_for, infrequent enough to be cheap.
--
--         The cron command reads the AUDIT_SHARED_SECRET via Vault (same
--         pattern as the existing reconcile + audit crons after migration
--         0019) so secret rotations propagate without redeploys.
--
-- Related: platform/supabase/migrations/0019_vault_helper_for_shared_secrets.sql
--          (the get_shared_secret helper this cron uses),
--          platform/supabase/migrations/0023_enrolment_auto_flip.sql
--          (existing daily cron, same shape),
--          platform/supabase/functions/social-publish/index.ts (the function
--          this cron triggers).

-- UP

-- Idempotent: unschedule any existing job with this name first, then schedule
-- fresh. cron.schedule() errors on duplicate jobname, so a re-apply or a
-- partial-failure replay would otherwise leave the migration permanently broken.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'social-publish-15min') THEN
    PERFORM cron.unschedule('social-publish-15min');
  END IF;
END $$;

SELECT cron.schedule(
  'social-publish-15min',
  '*/15 * * * *',
  $cmd$
    SELECT net.http_post(
      url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/social-publish',
      headers := jsonb_build_object(
        'x-audit-key', public.get_shared_secret('AUDIT_SHARED_SECRET'),
        'content-type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $cmd$
);

-- DOWN
-- SELECT cron.unschedule('social-publish-15min');
