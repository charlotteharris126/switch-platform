-- Migration 0076 — schedule email-stalled-cron-daily (Phase 2b)
-- Date: 2026-05-05
-- Author: Claude (platform Session 32) with owner sign-off
-- Reason: Phase 2b of the email platform rearchitecture (spec at
--   platform/docs/email-platform-rearchitecture-spec.md). The new Edge
--   Function email-stalled-cron scans for day-4 open leads (Phase-2-gated
--   via email_log) and fires the stalled email through sendTransactional.
--   09:00 UTC chosen to match the existing Brevo automation cadence and to
--   leave an hour of clearance ahead of email-u4-cron at 09:30 UTC.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: pg_cron schedule that POSTs to email-stalled-cron daily.
--      No table change.
--   2. Readers: email-stalled-cron reads leads.submissions, crm.email_log,
--      crm.enrolments. No new readers introduced beyond the function itself.
--   3. Writers: email-stalled-cron → sendTransactional → crm.email_log
--      INSERT/UPDATE + leads.dead_letter on failure.
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role/policy: function authenticates with x-audit-key (vault-stored
--      AUDIT_SHARED_SECRET). No new RLS policy.
--   7. Rollback: cron.unschedule (in DOWN). Edge Function stays deployed
--      but stops being triggered.
--   8. Sign-off: owner (this session).
--
-- Related:
--   platform/supabase/functions/email-stalled-cron/index.ts
--   platform/docs/email-platform-rearchitecture-spec.md (Phase 2b)
--   platform/supabase/migrations/0033_social_analytics_sync_cron.sql (pattern)

-- UP

-- Idempotent: unschedule any existing job with this name first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-stalled-cron-daily') THEN
    PERFORM cron.unschedule('email-stalled-cron-daily');
  END IF;
END $$;

SELECT cron.schedule(
  'email-stalled-cron-daily',
  '0 9 * * *',
  $cmd$
    SELECT net.http_post(
      url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/email-stalled-cron',
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
-- SELECT cron.unschedule('email-stalled-cron-daily');
