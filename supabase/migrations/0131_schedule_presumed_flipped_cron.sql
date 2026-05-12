-- Migration 0131 — schedule the post-flip provider notification cron
-- Date: 2026-05-12
-- Author: Claude (Sasha)
-- Reason:
--   Pairs with migration 0097 (already schedules 'enrolment-auto-flip-daily'
--   at 06:00 UTC + 'email-presumed-warning-cron-daily' at 05:00 UTC).
--   The new email-presumed-flipped-cron runs at 07:00 UTC daily — one
--   hour after the auto-flip cron — so newly-flipped leads from this
--   morning's run get notified the same morning. Cron-chain order:
--
--     05:00 UTC  email-presumed-warning-cron-daily   (day-before warning)
--     06:00 UTC  enrolment-auto-flip-daily           (the actual flip)
--     07:00 UTC  email-presumed-flipped-cron-daily   (the post-flip notice — NEW)
--
--   Dormant until BREVO_TEMPLATE_PROVIDER_PRESUMED_FLIPPED is set in
--   Supabase Vault (the Edge Function early-exits otherwise — see
--   functions/email-presumed-flipped-cron/index.ts).
--
-- Impact assessment:
--   1. Change: one pg_cron schedule entry. No table change.
--   2. Readers/writers: identical pattern to the 05:00 warning cron.
--   3. Rollback: cron.unschedule.
--   4. Sign-off: owner pending.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-presumed-flipped-cron-daily') THEN
    PERFORM cron.unschedule('email-presumed-flipped-cron-daily');
  END IF;
END $$;

SELECT cron.schedule(
  'email-presumed-flipped-cron-daily',
  '0 7 * * *',
  $cmd$
    SELECT net.http_post(
      url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/email-presumed-flipped-cron',
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
-- DO $$
-- BEGIN
--   IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-presumed-flipped-cron-daily') THEN
--     PERFORM cron.unschedule('email-presumed-flipped-cron-daily');
--   END IF;
-- END $$;
