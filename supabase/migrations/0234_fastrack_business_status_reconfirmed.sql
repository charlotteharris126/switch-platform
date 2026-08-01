-- Migration 0234 — add business_status_reconfirmed + business_status_mismatch_flag to leads.fastrack_submissions
-- Date: 2026-07-30
-- Author: Claude (Mable/switchable-site) with owner sign-off
-- Reason: the fastrack form re-attests every hard gate the course actually has,
--   so the provider gets a warm lead whose eligibility has been confirmed twice.
--   The three EMS York & North Yorkshire Skills Bootcamps gate on business
--   status, so their fastrack re-asks it. Symmetric with l3_reconfirmed (FCFJ),
--   earnings_reconfirmed (AEB) and support_role_reconfirmed (0225).
--   business_status_reconfirmed carries WHICH structure the learner reconfirmed
--   (the useful part for the provider's screening call + the 90/100% funding
--   split). business_status_mismatch_flag is stored (not just computed) because,
--   unlike support_role's hardcoded "none" rule, the disqualifying answer is
--   PER-COURSE (eligibility.business_status allow-list): not_trading DQs on
--   Digital Edge + Immediate Impact but passes on Creative Catapult. The page
--   knows the course allow-list (matrix.json) and computes the flag; the EF
--   stores it, mirroring l3_reconfirmed + l3_mismatch_flag. Answering with a
--   disqualifying structure is a hard DQ (entry + funding gate, no pay fork).
-- Impact: two additive nullable columns. NULL on every fastrack for a course
--   without the business_status step. No schema_version bump (additive).
--   Rollback = drop columns.
-- Related: platform/supabase/migrations/0225 (support_role_reconfirmed precedent),
--   0233 (leads.submissions.business_status), fastrack-receive EF.

-- UP
ALTER TABLE leads.fastrack_submissions ADD COLUMN IF NOT EXISTS business_status_reconfirmed text NULL;
ALTER TABLE leads.fastrack_submissions ADD COLUMN IF NOT EXISTS business_status_mismatch_flag boolean NULL;
COMMENT ON COLUMN leads.fastrack_submissions.business_status_reconfirmed IS
  'Business-status fastrack: the structure the learner reconfirmed at fastrack time. sole_trader / limited_company / partnership / not_trading. NULL on courses without the business_status gate. Added 2026-07-30.';
COMMENT ON COLUMN leads.fastrack_submissions.business_status_mismatch_flag IS
  'True when the reconfirmed business_status is disqualifying for THIS course (not in the course allow-list; computed page-side from matrix.json). Hard DQ, no pay fork. NULL when the question was not asked. Added 2026-07-30.';

-- DOWN
-- ALTER TABLE leads.fastrack_submissions DROP COLUMN IF EXISTS business_status_mismatch_flag;
-- ALTER TABLE leads.fastrack_submissions DROP COLUMN IF EXISTS business_status_reconfirmed;
