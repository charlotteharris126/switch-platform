-- Migration 0088 — schedule email-sunset-cron-daily + add re_engagement email_type
-- Date: 2026-05-07
-- Author: Claude (platform Session 34) with owner sign-off
-- Reason: Phase 5 dependency from the email rearchitecture spec
--   (deliverability section, "Sunset policy"). Marketing emails cannot be
--   safely turned on without an engagement-based suppression backstop:
--   contacts who never open after 180 days continue to receive marketing
--   sends, hurting sender reputation over time. Cron implements the
--   spec's two-phase rule:
--     Phase 1: contact has had ≥180 days of email contact history with
--              no open/click → fire one re-engagement email.
--     Phase 2: contact was sent re-engagement ≥14 days ago AND still no
--              open/click since → suppress (marketing_opt_in=false +
--              push channel=unsubscribed to Brevo).
--
--   Suppress is asymmetric — only the marketing (Email campaigns) channel
--   is unsubscribed; transactional (utility) sends continue. Mirrors the
--   asymmetric backfill rule from migration 0081 (Phase 3c).
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: extend crm.email_log.email_type CHECK to include
--      're_engagement'. Schedule pg_cron job email-sunset-cron-daily at
--      03:00 UTC (1h before brevo-consent-reconcile-daily so any
--      suppression flips have already settled before reconcile runs).
--   2. Readers: email-sunset-cron reads crm.email_log, leads.submissions.
--   3. Writers: email-sunset-cron → sendTransactional → crm.email_log
--      INSERT. Phase 2 also UPDATEs leads.submissions.marketing_opt_in
--      and INSERTs crm.consent_history (same pattern as
--      brevo-event-webhook's Phase 3a path).
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role/policy: cron uses the same x-audit-key vault lookup as
--      every other internal cron. Edge Function uses functions_writer
--      role for the marketing_opt_in flip (column-level grant + RLS
--      policy from migration 0079).
--   7. Rollback: cron.unschedule + DOWN reverts CHECK constraint.
--      Existing re_engagement rows would block constraint reversal —
--      DOWN includes a guard.
--   8. Sign-off: owner (this session, 2026-05-07).
--
-- Related:
--   platform/supabase/functions/email-sunset-cron/index.ts
--   platform/supabase/functions/_shared/brevo.ts (EmailLogType union)
--   platform/supabase/migrations/0081_brevo_consent_reconcile_cron.sql (sibling pattern)
--   platform/docs/email-platform-rearchitecture-spec.md (deliverability §)

BEGIN;

-- 1. Extend email_type CHECK constraint to include 're_engagement'.
ALTER TABLE crm.email_log DROP CONSTRAINT email_log_email_type_check;

ALTER TABLE crm.email_log ADD CONSTRAINT email_log_email_type_check
  CHECK (email_type IN (
    'u1_funded',
    'u1_self',
    'stalled_funded',
    'stalled_self',
    'chaser_funded',
    'chaser_self',
    'u4_funded',
    'u4_self',
    'n1',
    'n2',
    'n3',
    'referral_cold',
    'referral_lost',
    'newsletter',
    'provider_presumed_warning',
    're_engagement'
  ));

-- 1b. Extend crm.consent_history.source CHECK constraint to include
--     'sunset_suppression'. The cron's Phase 2 audit row needs a source
--     label distinct from the existing 'unsubscribe_link' / 'spam_complaint'
--     / 'reconcile_cron' values so analytics can attribute suppressions
--     correctly.
ALTER TABLE crm.consent_history DROP CONSTRAINT consent_history_source_check;

ALTER TABLE crm.consent_history ADD CONSTRAINT consent_history_source_check
  CHECK (source IN (
    'form',
    'unsubscribe_link',
    'spam_complaint',
    'admin_dashboard',
    'api',
    'reconcile_cron',
    'backfill',
    'sunset_suppression'
  ));

-- 2. Schedule daily cron. Idempotent unschedule first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-sunset-cron-daily') THEN
    PERFORM cron.unschedule('email-sunset-cron-daily');
  END IF;
END $$;

SELECT cron.schedule(
  'email-sunset-cron-daily',
  '0 3 * * *',
  $cmd$
    SELECT net.http_post(
      url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/email-sunset-cron',
      headers := jsonb_build_object(
        'x-audit-key',  public.get_shared_secret('AUDIT_SHARED_SECRET'),
        'content-type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cmd$
);

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DO $$
-- BEGIN
--   IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-sunset-cron-daily') THEN
--     PERFORM cron.unschedule('email-sunset-cron-daily');
--   END IF;
--
--   IF NOT EXISTS (SELECT 1 FROM crm.email_log WHERE email_type = 're_engagement') THEN
--     ALTER TABLE crm.email_log DROP CONSTRAINT email_log_email_type_check;
--     ALTER TABLE crm.email_log ADD CONSTRAINT email_log_email_type_check
--       CHECK (email_type IN (
--         'u1_funded','u1_self','stalled_funded','stalled_self',
--         'chaser_funded','chaser_self','u4_funded','u4_self',
--         'n1','n2','n3','referral_cold','referral_lost','newsletter',
--         'provider_presumed_warning'
--       ));
--   END IF;
--
--   IF NOT EXISTS (SELECT 1 FROM crm.consent_history WHERE source = 'sunset_suppression') THEN
--     ALTER TABLE crm.consent_history DROP CONSTRAINT consent_history_source_check;
--     ALTER TABLE crm.consent_history ADD CONSTRAINT consent_history_source_check
--       CHECK (source IN (
--         'form','unsubscribe_link','spam_complaint','admin_dashboard',
--         'api','reconcile_cron','backfill'
--       ));
--   END IF;
-- END $$;
-- COMMIT;
