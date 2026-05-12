-- Migration 0130 — extend crm.email_log.email_type CHECK for the post-flip notification
-- Date: 2026-05-12
-- Author: Claude (Sasha)
-- Reason:
--   The auto-flip cron (migration 0129) marks stale Open leads as
--   presumed_enrolled / presumed_employer_signed. Charlotte's spec is that
--   the provider then needs an email telling them
--     - their lead has flipped
--     - they have 7 days to dispute or update before it locks in for
--       billing
--   Separate Edge Function `email-presumed-flipped-cron` will run shortly
--   after the auto-flip cron and emit one batched email per provider.
--   That function calls _shared/brevo.ts sendTransactional with the new
--   email_type 'provider_presumed_flipped' — the email_log CHECK needs
--   to allow it.
--
--   Adding:
--     - provider_presumed_flipped — post-flip notice to provider
--
-- Impact assessment:
--   1. Change: replace the email_log_email_type_check constraint with one
--      that includes the new value. All previous values preserved.
--   2. Readers: email_log analytics, idempotency lookups in
--      sendTransactional.
--   3. Writers: new email-presumed-flipped-cron Edge Function.
--   4. Rollback: replace constraint without the new value. Safe iff no
--      rows have been inserted with the new type yet.
--   5. Sign-off: owner pending.

BEGIN;

ALTER TABLE crm.email_log DROP CONSTRAINT IF EXISTS email_log_email_type_check;

ALTER TABLE crm.email_log
  ADD CONSTRAINT email_log_email_type_check
  CHECK (email_type = ANY (ARRAY[
    'u1_funded', 'u1_self',
    'stalled_funded', 'stalled_self',
    'chaser_funded', 'chaser_self',
    'u4_funded', 'u4_self',
    'n1', 'n2', 'n3',
    'referral_cold', 'referral_lost',
    'newsletter',
    'provider_presumed_warning',
    'provider_presumed_flipped',
    're_engagement',
    's4b_employer_u1',
    's4b_employer_ud'
  ]::text[]));

COMMIT;
