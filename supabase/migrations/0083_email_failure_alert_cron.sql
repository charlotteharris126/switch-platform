-- Migration 0083 — schedule email-failure-alert-daily (Phase 6c)
-- Date:    2026-05-06
-- Author:  Claude (platform Session 33) on Charlotte's request
-- Reason:  Phase 6c of the email rearch spec — last unfinished item.
--          Daily 04:30 UTC. Counts failures in the last 24h of
--          crm.email_log; if ≥ 3, sends an alert email to the owner and
--          writes a leads.dead_letter row.
--
--          04:30 UTC slots between the brevo-consent-reconcile-daily run
--          (04:00) and the email-stalled-cron / email-u4-cron at 09:00 /
--          09:30. Catches yesterday's failures before today's batch fires.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: pg_cron schedule. No table change.
--   2. Readers: function reads crm.email_log with channel='transactional'.
--   3. Writers: sendBrevoEmail to owner + leads.dead_letter INSERT.
--      functions_writer role for the dead_letter write.
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role/policy: function authenticates with x-audit-key.
--   7. Rollback: cron.unschedule (in DOWN). Function stays deployed but
--      stops triggering.
--   8. Sign-off: owner (this session).
--
-- Related:
--   platform/supabase/functions/email-failure-alert-daily/index.ts
--   platform/docs/email-platform-rearchitecture-spec.md (Phase 6c)

-- UP

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-failure-alert-daily') THEN
    PERFORM cron.unschedule('email-failure-alert-daily');
  END IF;
END $$;

SELECT cron.schedule(
  'email-failure-alert-daily',
  '30 4 * * *',
  $cmd$
    SELECT net.http_post(
      url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/email-failure-alert-daily',
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
-- SELECT cron.unschedule('email-failure-alert-daily');
