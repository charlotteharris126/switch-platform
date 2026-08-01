-- Migration 0235 — allow lost_reason 'business_status_mismatch' on crm.enrolments
-- Date: 2026-07-30
-- Author: Claude (Mable/switchable-site) with owner sign-off
-- Reason: the EMS York & North Yorkshire Skills Bootcamp fastracks re-attest the
--   business-status gate. Reconfirming a structure that disqualifies for that
--   course (per-course allow-list; e.g. not_trading on Digital Edge / Immediate
--   Impact) is a hard DQ, and fastrack-receive flips the enrolment to lost,
--   exactly as it does for l3_mismatch_self_reported, support_role_mismatch and
--   cohort_decline. Without extending this CHECK the UPDATE throws 23514 and the
--   flip fails at runtime. Mirrors 0226 (support_role_mismatch).
-- Impact: widens an existing CHECK to permit one additional value. No existing
--   row changes, no reader breaks (a wider domain is backwards compatible).
--   Downstream: SW_LOST_REASON in Brevo gains a possible new value, and any
--   admin lost-reason filter/label map should learn it. Rollback is only safe
--   once no row uses the value.
-- Related: platform/supabase/migrations/0226 (support_role_mismatch precedent),
--   0234 (fastrack business_status columns), fastrack-receive EF.

-- UP
ALTER TABLE crm.enrolments DROP CONSTRAINT IF EXISTS enrolments_lost_reason_chk;
ALTER TABLE crm.enrolments ADD CONSTRAINT enrolments_lost_reason_chk
  CHECK (
    lost_reason IS NULL OR lost_reason = ANY (ARRAY[
      'not_interested', 'wrong_course', 'funding_issue', 'cancelled',
      'withdrew_after_enrolment', 'l3_mismatch_self_reported', 'cohort_decline',
      'budget', 'wrong_levy_fit', 'timing', 'competitor',
      'decided_not_to_proceed', 'no_response', 'support_role_mismatch',
      'business_status_mismatch', 'other'
    ]::text[])
  );

-- DOWN
-- ALTER TABLE crm.enrolments DROP CONSTRAINT IF EXISTS enrolments_lost_reason_chk;
-- ALTER TABLE crm.enrolments ADD CONSTRAINT enrolments_lost_reason_chk
--   CHECK (lost_reason IS NULL OR lost_reason = ANY (ARRAY[
--     'not_interested','wrong_course','funding_issue','cancelled',
--     'withdrew_after_enrolment','l3_mismatch_self_reported','cohort_decline',
--     'budget','wrong_levy_fit','timing','competitor',
--     'decided_not_to_proceed','no_response','support_role_mismatch','other']::text[]));
