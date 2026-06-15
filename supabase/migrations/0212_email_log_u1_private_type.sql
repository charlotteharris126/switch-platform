-- Migration 0212 — allow email_type 'u1_private' in crm.email_log
-- Date: 2026-06-15
-- Author: Claude (Sasha session) on Charlotte's direction
-- Reason: Private-pay learners get their own welcome email (single-course +
--   payment framing) distinct from u1_funded ("confirm you qualify") and u1_self
--   (multi-course). route-lead.ts now logs these sends as email_type='u1_private',
--   which the existing email_log_email_type_check constraint rejects. Add it.
-- Related: _shared/route-lead.ts sendU1Transactional (3-way branch),
--   switchable/email/html-exports/u1-private.html (template source).
-- Impact assessment:
--   - Changes: widens one CHECK constraint by one allowed value. Additive.
--   - Consumers: anything reading email_log.email_type (admin email parity
--     column, reporting) gains a new value; none break on an extra enum member.
--   - Deploy order: this migration FIRST, then redeploy the route-lead.ts
--     bundlers, so a 'u1_private' INSERT never hits the old constraint.
--   - Rollback: restore the prior constraint (DOWN); only safe once no rows
--     hold 'u1_private'.
--   - Sign-off: Charlotte (this session).

-- UP
ALTER TABLE crm.email_log DROP CONSTRAINT email_log_email_type_check;
ALTER TABLE crm.email_log ADD CONSTRAINT email_log_email_type_check CHECK (
  email_type = ANY (ARRAY[
    'u1_funded', 'u1_self', 'u1_private',
    'stalled_funded', 'stalled_self',
    'chaser_funded', 'chaser_self',
    'u4_funded', 'u4_self',
    'n1', 'n2', 'n3',
    'referral_cold', 'referral_lost',
    'newsletter',
    'provider_presumed_warning', 'provider_presumed_flipped',
    're_engagement',
    's4b_employer_u1', 's4b_employer_ud', 's4b_employer_chaser',
    'u_fastrack_qualified'
  ]::text[])
);

-- DOWN
-- ALTER TABLE crm.email_log DROP CONSTRAINT email_log_email_type_check;
-- ALTER TABLE crm.email_log ADD CONSTRAINT email_log_email_type_check CHECK (
--   email_type = ANY (ARRAY[
--     'u1_funded','u1_self','stalled_funded','stalled_self','chaser_funded',
--     'chaser_self','u4_funded','u4_self','n1','n2','n3','referral_cold',
--     'referral_lost','newsletter','provider_presumed_warning',
--     'provider_presumed_flipped','re_engagement','s4b_employer_u1',
--     's4b_employer_ud','s4b_employer_chaser','u_fastrack_qualified'
--   ]::text[])
-- );
