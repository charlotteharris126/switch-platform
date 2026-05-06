-- Migration 0081 — schedule brevo-consent-reconcile-daily (Phase 3d)
-- Date: 2026-05-06
-- Author: Claude (platform Session 33) with owner sign-off
-- Reason: Phase 3d of the email platform rearchitecture (spec at
--   platform/docs/email-platform-rearchitecture-spec.md). The new Edge
--   Function brevo-consent-reconcile-daily walks every Brevo contact,
--   compares Email campaigns channel state (emailBlacklisted) against the
--   latest marketing_opt_in for that email in leads.submissions, auto-
--   corrects drift in the safe direction (Brevo blocked but DB consenting
--   → DB updated to non-consenting; never the reverse), logs every
--   correction to crm.consent_history, and writes a leads.dead_letter
--   alert if drift rate > 2%.
--
--   04:00 UTC chosen to:
--     - run before the 06:00 enrolment auto-flip cron (currently paused
--       per migration 0080) so daily ordering is reconcile-then-flip
--       once the auto-flip resumes
--     - sit two hours ahead of the 06:00 Meta ads ingestion (no contention)
--     - leave 5 hours of headroom before the 09:00 stalled cron
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: pg_cron schedule that POSTs to brevo-consent-reconcile-daily
--      once daily. No table change.
--   2. Readers: function reads leads.submissions (latest marketing_opt_in
--      per email), Brevo /v3/contacts (paginated). No new readers introduced
--      beyond the function itself.
--   3. Writers: function UPDATEs leads.submissions.marketing_opt_in for
--      drift in the safe direction (under functions_writer role, leveraging
--      the column-level grant added in migration 0079); INSERTs to
--      crm.consent_history per correction; INSERTs to leads.dead_letter on
--      drift > 2% threshold breach. No writes to Brevo (this cron is read-
--      only against Brevo; the outbound enforcement is Phase 3b's job).
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role/policy: function authenticates with x-audit-key (vault-stored
--      AUDIT_SHARED_SECRET). Reuses functions_writer write grant added in
--      migration 0079 for the marketing_opt_in column. No new RLS policy.
--   7. Rollback: cron.unschedule (in DOWN). Edge Function stays deployed
--      but stops being triggered. Any prior corrections to DB stand
--      (they're correct — Brevo was the source of truth on those).
--   8. Sign-off: owner (this session).
--
-- Related:
--   platform/supabase/functions/brevo-consent-reconcile-daily/index.ts
--   platform/docs/email-platform-rearchitecture-spec.md (Phase 3d)
--   platform/supabase/migrations/0076_email_stalled_cron.sql (pattern)
--   platform/supabase/migrations/0079_consent_writeback_grants.sql (column-level grant reused)

-- UP

-- Idempotent: unschedule any existing job with this name first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'brevo-consent-reconcile-daily') THEN
    PERFORM cron.unschedule('brevo-consent-reconcile-daily');
  END IF;
END $$;

SELECT cron.schedule(
  'brevo-consent-reconcile-daily',
  '0 4 * * *',
  $cmd$
    SELECT net.http_post(
      url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/brevo-consent-reconcile-daily',
      headers := jsonb_build_object(
        'x-audit-key', public.get_shared_secret('AUDIT_SHARED_SECRET'),
        'content-type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cmd$
);

-- DOWN
-- SELECT cron.unschedule('brevo-consent-reconcile-daily');
