-- Migration 0125 — extend crm.email_log.email_type CHECK to cover employer-lead types
-- Date: 2026-05-12
-- Author: Claude (Sasha) — Riverside / S4B v1 launch
-- Reason:
--   netlify-employer-lead-router needs to send U1 (ack-to-employer) and UD
--   (disqualified-ack-to-employer) via _shared/brevo.ts `sendTransactional`,
--   which writes a row to crm.email_log with email_type as the discriminator.
--   The current CHECK constraint covers learner types only (u1_funded,
--   u1_self, stalled_*, chaser_*, u4_*, n1/n2/n3, referral_*, newsletter,
--   provider_presumed_warning, re_engagement). Without this migration,
--   sendTransactional fails with a constraint violation on every B2B send.
--
--   Adding two new values:
--     - s4b_employer_u1     -- "we've got your details, Riverside will be in touch"
--     - s4b_employer_ud     -- polite "not a fit right now, we'll keep you posted"
--
--   The provider-facing U2 notification stays as inline-HTML via sendBrevoEmail
--   (mirrors the funded-provider notification pattern in _shared/route-lead.ts).
--   It does NOT write to email_log, so no new value needed for U2.
--
-- Impact assessment:
--   1. Change: replace the email_log_email_type_check constraint with one
--      that includes the two new values. Old values preserved.
--   2. Readers: email_log analytics (Iris, Mira); no existing query reads
--      these new values yet so safe.
--   3. Writers: sendTransactional in _shared/brevo.ts via the new
--      employer email-send paths.
--   4. Rollback: drop + recreate without the new values. Backwards-safe
--      iff no rows have been inserted with the new types yet.
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
    're_engagement',
    -- Switchable for Business v1 (employer apprenticeship leads)
    's4b_employer_u1',
    's4b_employer_ud'
  ]::text[]));

COMMIT;

-- DOWN
-- BEGIN;
-- ALTER TABLE crm.email_log DROP CONSTRAINT IF EXISTS email_log_email_type_check;
-- ALTER TABLE crm.email_log
--   ADD CONSTRAINT email_log_email_type_check
--   CHECK (email_type = ANY (ARRAY[
--     'u1_funded','u1_self','stalled_funded','stalled_self','chaser_funded','chaser_self',
--     'u4_funded','u4_self','n1','n2','n3','referral_cold','referral_lost',
--     'newsletter','provider_presumed_warning','re_engagement'
--   ]::text[]));
-- COMMIT;
