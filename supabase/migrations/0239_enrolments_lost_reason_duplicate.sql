-- Migration 0239 — allow 'duplicate' in crm.enrolments.lost_reason
-- Date: 2026-08-03
-- Author: Claude (Sasha/platform session) with owner sign-off
-- Reason: cross-channel employer duplicates (same employer via Instant Form +
--   on-site /business/ form) get one lead kept and the other marked a dupe; the
--   dupe's enrolment is closed with lost_reason 'duplicate'. First case: Andy
--   Lyden (#767 dupe of #768). The auto-dedup (employer-lead-core) skips creating
--   an enrolment for future dupes, so this value is mainly for closing pre-dedup
--   dupe enrolments + any manual dupe cleanup. Superset of the prior 16 values.
-- Impact (§8): CHECK widen on crm.enrolments. No consumer filters lost_reason to
--   a closed set that breaks on the new value. Reversible (DOWN restores prior).

-- UP
ALTER TABLE crm.enrolments DROP CONSTRAINT enrolments_lost_reason_chk;
ALTER TABLE crm.enrolments ADD CONSTRAINT enrolments_lost_reason_chk
  CHECK (lost_reason IS NULL OR lost_reason = ANY (ARRAY[
    'not_interested'::text, 'wrong_course'::text, 'funding_issue'::text,
    'cancelled'::text, 'withdrew_after_enrolment'::text, 'l3_mismatch_self_reported'::text,
    'cohort_decline'::text, 'budget'::text, 'wrong_levy_fit'::text, 'timing'::text,
    'competitor'::text, 'decided_not_to_proceed'::text, 'no_response'::text,
    'support_role_mismatch'::text, 'business_status_mismatch'::text,
    'duplicate'::text, 'other'::text
  ]));

-- DOWN
-- ALTER TABLE crm.enrolments DROP CONSTRAINT enrolments_lost_reason_chk;
-- ALTER TABLE crm.enrolments ADD CONSTRAINT enrolments_lost_reason_chk
--   CHECK (lost_reason IS NULL OR lost_reason = ANY (ARRAY[
--     'not_interested','wrong_course','funding_issue','cancelled','withdrew_after_enrolment',
--     'l3_mismatch_self_reported','cohort_decline','budget','wrong_levy_fit','timing',
--     'competitor','decided_not_to_proceed','no_response','support_role_mismatch',
--     'business_status_mismatch','other'
--   ]));
