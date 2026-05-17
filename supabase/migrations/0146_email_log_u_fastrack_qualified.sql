-- Migration 0146 — extend email_log_email_type_check for u_fastrack_qualified
-- Date: 2026-05-17
-- Author: Sasha (platform Session 50) with owner review
-- Reason: New transactional template 'u-fastrack-qualified' fires from
-- fastrack-receive when a learner submits the fastrack form AND clears the
-- qualifying conditions (cohort_confirmed === true AND l3_reconfirmed === false).
-- Confirms the application step and sets the learner's expectation for the
-- named-rep callback. Legal basis: contract — goes regardless of marketing_opt_in.
-- Related: switchable/email/CLAUDE.md transactional list, fastrack-receive Edge Function.

-- UP
ALTER TABLE crm.email_log DROP CONSTRAINT email_log_email_type_check;
ALTER TABLE crm.email_log ADD CONSTRAINT email_log_email_type_check
  CHECK (email_type = ANY (ARRAY[
    'u1_funded'::text, 'u1_self'::text,
    'stalled_funded'::text, 'stalled_self'::text,
    'chaser_funded'::text, 'chaser_self'::text,
    'u4_funded'::text, 'u4_self'::text,
    'n1'::text, 'n2'::text, 'n3'::text,
    'referral_cold'::text, 'referral_lost'::text,
    'newsletter'::text,
    'provider_presumed_warning'::text, 'provider_presumed_flipped'::text,
    're_engagement'::text,
    's4b_employer_u1'::text, 's4b_employer_ud'::text,
    'u_fastrack_qualified'::text
  ]));

-- DOWN
-- Rollback drops the new value from the CHECK. Will fail if any rows with
-- email_type='u_fastrack_qualified' exist; delete those rows manually before
-- rolling back, or restore from backup.
-- ALTER TABLE crm.email_log DROP CONSTRAINT email_log_email_type_check;
-- ALTER TABLE crm.email_log ADD CONSTRAINT email_log_email_type_check
--   CHECK (email_type = ANY (ARRAY[
--     'u1_funded'::text, 'u1_self'::text,
--     'stalled_funded'::text, 'stalled_self'::text,
--     'chaser_funded'::text, 'chaser_self'::text,
--     'u4_funded'::text, 'u4_self'::text,
--     'n1'::text, 'n2'::text, 'n3'::text,
--     'referral_cold'::text, 'referral_lost'::text,
--     'newsletter'::text,
--     'provider_presumed_warning'::text, 'provider_presumed_flipped'::text,
--     're_engagement'::text,
--     's4b_employer_u1'::text, 's4b_employer_ud'::text
--   ]));
