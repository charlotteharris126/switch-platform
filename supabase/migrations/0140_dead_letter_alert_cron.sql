-- Migration 0140 — schedule dead-letter-alert-cron (hourly)
-- Date:   2026-05-13
-- Author: Claude (Sasha) with owner review
-- Reason:
--   `leads.dead_letter` captures honest signals — every Edge Function that
--   fails routes here before it returns to its caller. Today Emma Newton's
--   fastrack auto-DQ rolled back due to RLS gap on crm.lead_notes; the
--   dead_letter row was written but went unnoticed for 8 hours because the
--   only existing read cadence is Sasha's Monday weekly health report.
--
--   This cron flips dead_letter from a passive log to an active signal:
--   every hour, query for unreplayed rows added in the last 65 min, and
--   email Charlotte one summary if any exist. Marking a row replayed
--   (via /admin/errors or manual UPDATE) immediately removes it from
--   future alerts.
--
--   05 past the hour chosen to avoid clashing with cron-heavy 00 / 30
--   minute slots (auto-flip, presumed-warning, etc. — see public.vw_cron_jobs).
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: pg_cron schedule. No table change.
--   2. Readers: function reads leads.dead_letter (count + last 65 min).
--   3. Writers: Brevo API only (no DB write).
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role/policy: x-audit-key auth, vault-read fetches AUDIT_SHARED_SECRET.
--   7. Rollback: cron.unschedule (DOWN). Function stays deployed.
--   8. Sign-off: owner.
--
-- Pre-activation requirement: OWNER_NOTIFICATION_EMAIL or BREVO_SENDER_EMAIL
-- set on the dead-letter-alert-cron function deploy. Without either, the
-- function returns ok with skipped=1; no email fired. Brevo template not
-- required (inline HTML).
--
-- Related:
--   platform/supabase/functions/dead-letter-alert-cron/index.ts

-- UP

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dead-letter-alert-hourly') THEN
    PERFORM cron.unschedule('dead-letter-alert-hourly');
  END IF;
END $$;

SELECT cron.schedule(
  'dead-letter-alert-hourly',
  '5 * * * *',
  $cmd$
    SELECT net.http_post(
      url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/dead-letter-alert-cron',
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
-- SELECT cron.unschedule('dead-letter-alert-hourly');
