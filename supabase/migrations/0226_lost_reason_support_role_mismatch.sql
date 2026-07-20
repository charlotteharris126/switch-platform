-- Migration 0226 — allow lost_reason 'support_role_mismatch' on crm.enrolments
-- Date: 2026-07-20
-- Author: Claude (Mable/switchable-site) with owner sign-off
-- Reason: the counselling support-roles fastrack re-attests the support-role
--   gate. Answering "none of these" is a hard DQ, and fastrack-receive flips the
--   enrolment to lost, exactly as it already does for l3_mismatch_self_reported
--   and cohort_decline. Without extending this CHECK the UPDATE throws 23514 and
--   the flip fails at runtime (verified against the live constraint before
--   writing this migration — the value was absent).
-- Impact: widens an existing CHECK to permit one additional value. No existing
--   row changes, no consumer breaks (a wider domain is backwards compatible for
--   readers). Downstream: SW_LOST_REASON in Brevo gains a possible new value, and
--   any admin lost-reason filter/label map should learn it. Rollback is only safe
--   once no row uses the value.

-- UP
ALTER TABLE crm.enrolments DROP CONSTRAINT IF EXISTS enrolments_lost_reason_chk;
ALTER TABLE crm.enrolments ADD CONSTRAINT enrolments_lost_reason_chk
  CHECK (
    lost_reason IS NULL OR lost_reason = ANY (ARRAY[
      'not_interested', 'wrong_course', 'funding_issue', 'cancelled',
      'withdrew_after_enrolment', 'l3_mismatch_self_reported', 'cohort_decline',
      'budget', 'wrong_levy_fit', 'timing', 'competitor',
      'decided_not_to_proceed', 'no_response', 'support_role_mismatch', 'other'
    ]::text[])
  );

-- DOWN
-- ALTER TABLE crm.enrolments DROP CONSTRAINT IF EXISTS enrolments_lost_reason_chk;
-- ALTER TABLE crm.enrolments ADD CONSTRAINT enrolments_lost_reason_chk
--   CHECK (lost_reason IS NULL OR lost_reason = ANY (ARRAY[
--     'not_interested','wrong_course','funding_issue','cancelled',
--     'withdrew_after_enrolment','l3_mismatch_self_reported','cohort_decline',
--     'budget','wrong_levy_fit','timing','competitor',
--     'decided_not_to_proceed','no_response','other']::text[]));
