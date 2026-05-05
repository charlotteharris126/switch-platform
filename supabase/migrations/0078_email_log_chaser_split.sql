-- Migration 0078 — split crm.email_log.email_type 'chaser' into 'chaser_funded' + 'chaser_self'
-- Date: 2026-05-05
-- Author: Claude (platform Session 32) with owner sign-off
-- Reason: Phase 2b spec assumed a single chaser template, but the actual
--   Brevo setup has two (id 6 funded, id 12 self), matching the funded/self
--   split already in place for U1, stalled, and U4. Splitting the email_type
--   value keeps the per-funded-route distinction visible in email_log
--   analytics and matches the pattern of every other utility email type.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: ALTER TABLE drop + add CHECK constraint on
--      crm.email_log.email_type. Replaces 'chaser' with 'chaser_funded' and
--      'chaser_self'.
--   2. Readers: nothing reads 'chaser' from email_log yet (Phase 2b just
--      shipped this session, no chaser rows yet — verified by SELECT before
--      this migration).
--   3. Writers: admin-brevo-chase being redeployed in the same session to
--      emit 'chaser_funded' / 'chaser_self' based on submission's
--      funding_category. EmailLogType TS union in _shared/brevo.ts updated
--      to match.
--   4. Schema version: not affected (internal table).
--   5. Data migration: none — no existing rows with email_type='chaser'.
--   6. Role/policy: no change.
--   7. Rollback: DOWN restores the original constraint with 'chaser'. Safe
--      until any 'chaser_funded' / 'chaser_self' rows exist.
--   8. Sign-off: owner (this session).
--
-- Related:
--   platform/supabase/migrations/0073_crm_email_log.sql (original CHECK)
--   platform/supabase/functions/admin-brevo-chase/index.ts
--   platform/supabase/functions/_shared/brevo.ts (EmailLogType union)

BEGIN;

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
    'newsletter'
  ));

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- ALTER TABLE crm.email_log DROP CONSTRAINT email_log_email_type_check;
-- ALTER TABLE crm.email_log ADD CONSTRAINT email_log_email_type_check
--   CHECK (email_type IN (
--     'u1_funded','u1_self','stalled_funded','stalled_self','chaser',
--     'u4_funded','u4_self','n1','n2','n3','referral_cold','referral_lost','newsletter'
--   ));
-- COMMIT;
