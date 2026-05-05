-- Migration 0077 — schedule email-u4-cron-daily (Phase 2b)
-- Date: 2026-05-05
-- Author: Claude (platform Session 32) with owner sign-off
-- Reason: Phase 2b of the email platform rearchitecture (spec at
--   platform/docs/email-platform-rearchitecture-spec.md). The new Edge
--   Function email-u4-cron scans for enrolled / presumed_enrolled leads
--   (Phase-2-gated via email_log) and fires the U4 enrolment-confirmation
--   email through sendTransactional. 09:30 UTC chosen to match the existing
--   Brevo U4 automation cadence and to run 30 min after stalled-cron.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: pg_cron schedule that POSTs to email-u4-cron daily.
--   2. Readers: email-u4-cron reads crm.enrolments, leads.submissions,
--      crm.email_log.
--   3. Writers: email-u4-cron → sendTransactional → crm.email_log
--      INSERT/UPDATE + leads.dead_letter on failure.
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role/policy: function authenticates with x-audit-key.
--   7. Rollback: cron.unschedule (in DOWN).
--   8. Sign-off: owner (this session).

-- UP

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-u4-cron-daily') THEN
    PERFORM cron.unschedule('email-u4-cron-daily');
  END IF;
END $$;

SELECT cron.schedule(
  'email-u4-cron-daily',
  '30 9 * * *',
  $cmd$
    SELECT net.http_post(
      url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/email-u4-cron',
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
-- SELECT cron.unschedule('email-u4-cron-daily');
