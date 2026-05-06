-- Migration 0084 — extend email_log email_type to include provider_presumed_warning
-- Date:    2026-05-06
-- Author:  Claude (platform Session 33) on Charlotte's request
-- Reason:  New email type for the day-12 provider warning (Phase 6d-ish — not
--          in original spec but added today). Fires 2 days before the 14-day
--          auto-flip would mark a lead presumed_enrolled, giving the provider
--          a grace window to confirm or dispute. Required before the auto-flip
--          cron (paused per migration 0080) can be safely re-enabled.
--
--          The existing email_type CHECK constraint enumerates all permitted
--          values. Adding a new entry needs the constraint dropped and
--          re-added. Pure additive change — no rows are reclassified.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: drop + recreate CHECK constraint with new allowed value.
--   2. Readers: dashboard + email_log queries are agnostic to enum values.
--   3. Writers: new email-presumed-warning-cron (sister migration 0085) writes
--      this type. Existing writers don't.
--   4. Schema version: not affected (additive enum expansion).
--   5. Data migration: none — new value, no existing rows reclassified.
--   6. Role/policy: no change.
--   7. Rollback: drop constraint + re-add with old taxonomy. Any rows holding
--      'provider_presumed_warning' would need cleared first.
--   8. Sign-off: owner (this session).
--
-- Related:
--   platform/supabase/functions/email-presumed-warning-cron/index.ts
--   platform/supabase/migrations/0080_pause_enrolment_auto_flip.sql
--   platform/supabase/migrations/0085_email_presumed_warning_cron.sql

-- UP

ALTER TABLE crm.email_log DROP CONSTRAINT email_log_email_type_check;

ALTER TABLE crm.email_log
  ADD CONSTRAINT email_log_email_type_check
  CHECK (email_type = ANY (ARRAY[
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
    'provider_presumed_warning'
  ]));

-- DOWN
-- ALTER TABLE crm.email_log DROP CONSTRAINT email_log_email_type_check;
-- ALTER TABLE crm.email_log
--   ADD CONSTRAINT email_log_email_type_check
--   CHECK (email_type = ANY (ARRAY['u1_funded','u1_self','stalled_funded','stalled_self','chaser_funded','chaser_self','u4_funded','u4_self','n1','n2','n3','referral_cold','referral_lost','newsletter']));
