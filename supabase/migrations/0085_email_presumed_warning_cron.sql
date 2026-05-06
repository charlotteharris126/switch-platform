-- Migration 0085 — schedule email-presumed-warning-cron (day-12 warning)
-- Date:    2026-05-06
-- Author:  Claude (platform Session 33) on Charlotte's request
-- Reason:  Day-12 provider warning. Fires daily 05:00 UTC. Catches routed
--          leads in the 12-14 day window with status='open' and emails the
--          provider 2 days ahead of the auto-flip-to-presumed_enrolled.
--
--          This is the prerequisite for re-enabling the auto-flip cron
--          (paused per migration 0080 after the 6 May incident where 5
--          leads silently flipped without provider awareness). Once this
--          warning has been live and verified for several days, the auto-
--          flip cron can be re-scheduled.
--
--          05:00 UTC chosen to:
--            - run after brevo-consent-reconcile-daily (04:00) and
--              email-failure-alert-daily (04:30)
--            - run BEFORE the auto-flip cron's old 06:00 slot (when re-enabled,
--              warnings should land before flips fire)
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: pg_cron schedule. No table change.
--   2. Readers: function reads leads.routing_log, crm.enrolments,
--      leads.submissions, crm.providers, crm.email_log.
--   3. Writers: sendTransactional → crm.email_log + Brevo API. Plus extra
--      email_log INSERTs for batch siblings under functions_writer role.
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role/policy: function authenticates with x-audit-key. Reuses
--      functions_writer for email_log writes (existing grant).
--   7. Rollback: cron.unschedule (in DOWN). Function stays deployed.
--   8. Sign-off: owner (this session).
--
-- Pre-activation requirement (cron is dormant until this is done):
--   - Charlotte creates the Brevo template with params PROVIDER_NAME,
--     CONTACT_NAME, COUNT, LEADS_HTML, FLIP_DATE.
--   - Sets BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING in Supabase Vault.
--   Until that env var is set, the cron runs but exits early with
--   reason="BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING env not set".
--
-- Related:
--   platform/supabase/functions/email-presumed-warning-cron/index.ts
--   platform/supabase/migrations/0080_pause_enrolment_auto_flip.sql
--   platform/supabase/migrations/0084_email_log_provider_presumed_warning_type.sql

-- UP

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-presumed-warning-cron-daily') THEN
    PERFORM cron.unschedule('email-presumed-warning-cron-daily');
  END IF;
END $$;

SELECT cron.schedule(
  'email-presumed-warning-cron-daily',
  '0 5 * * *',
  $cmd$
    SELECT net.http_post(
      url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/email-presumed-warning-cron',
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
-- SELECT cron.unschedule('email-presumed-warning-cron-daily');
