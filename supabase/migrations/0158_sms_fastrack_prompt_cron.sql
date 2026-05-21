-- Migration 0158 — pg_cron schedule for sms-fastrack-prompt-cron (every minute)
-- Date: 2026-05-21
-- Author: Claude (Sasha, platform session) with owner sign-off
-- Reason:
--   Chunk 3 of SMS utility build per `switchable/email/docs/sms-utility-design.md`
--   (Wren, locked 2026-05-21). Trigger A — fastrack-link prompt SMS that fires
--   10 minutes after routing for matched funded leads that haven't fastracked
--   yet. Cron scans for eligible candidates, narrow window (10-60 min post-
--   routing) caps the per-run set tightly; sendSms idempotency on
--   (submission_id, 'call_reminder_fastrack_link') guarantees one-shot per
--   learner.
--
-- Related:
--   platform/supabase/functions/sms-fastrack-prompt-cron/index.ts (receiver)
--   platform/supabase/functions/_shared/sms-utility.ts (fireFastrackLinkSms)
--   platform/supabase/migrations/0156 (crm.sms_log foundation + provider opt-out flags)
--   platform/supabase/migrations/0081 (brevo-consent-reconcile-daily cron — same dispatch shape)
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: one pg_cron schedule. No DDL, no function. The receiver EF was
--      deployed in the same chunk.
--   2. Readers / writers: the EF itself queries leads.submissions + crm.enrolments +
--      crm.providers (read) and crm.sms_log (write via sendSms). leads.dead_letter
--      write on send-failure. No new tables, no new columns.
--   3. Schema_version: no contract bumped.
--   4. Data migration: none.
--   5. New role / policy: none. EF runs as functions_writer via SUPABASE_DB_URL
--      pattern (same as netlify-partial-capture, fastrack-receive, sms-chaser-attempt-1).
--   6. Rollback: cron.unschedule in DOWN.
--   7. Sign-off: owner 2026-05-21.
--
-- Why every minute (vs less frequent):
--   - The eligibility window is 10-60 min post-routing — narrow by design.
--   - Per-run candidate count is small at pilot volume (single-digit candidates
--     most of the time).
--   - A learner who lands on /funded/thank-you/ and walks away at T+11min
--     should get the SMS within the next minute, not 14 minutes later.
--   - pg_cron at-minute precision is the right granularity.

BEGIN;

-- Idempotent re-schedule. Drops any prior entry under the same name (none on
-- first apply; the safety net protects re-applies from failing).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sms-fastrack-prompt-cron') THEN
    PERFORM cron.unschedule('sms-fastrack-prompt-cron');
  END IF;
END $$;

SELECT cron.schedule(
  'sms-fastrack-prompt-cron',
  '* * * * *',  -- every minute
  $cmd$
    SELECT net.http_post(
      url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/sms-fastrack-prompt-cron',
      headers := jsonb_build_object(
        'x-audit-key', public.get_shared_secret('AUDIT_SHARED_SECRET'),
        'content-type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $cmd$
);

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- SELECT cron.unschedule('sms-fastrack-prompt-cron');
-- COMMIT;
