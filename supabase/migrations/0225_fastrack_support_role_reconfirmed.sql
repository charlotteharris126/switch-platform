-- Migration 0225 — add support_role_reconfirmed to leads.fastrack_submissions
-- Date: 2026-07-20
-- Author: Claude (Mable/switchable-site) with owner sign-off
-- Reason: the fastrack form re-attests every hard gate the course actually has,
--   so the provider gets a warm lead whose eligibility has been confirmed twice.
--   The counselling support-roles course gates on sector, so its fastrack asks
--   the sector question again. Captured and surfaced to the provider, symmetric
--   with l3_reconfirmed (FCFJ) and earnings_reconfirmed (0201, AEB earnings).
--   New posted field support_role_reconfirmed from the fastrack-funded-v1 form.
--   Answer "none" is a hard DQ and flips the enrolment to lost with
--   lost_reason 'fastrack-support-role-mismatch'.
-- Note on type: TEXT, not boolean. l3/earnings reconfirms are yes-or-no, but
--   this one carries WHICH sector, which is the useful part for the provider's
--   screening call. Storing a bool would throw away the answer.
-- Impact: additive nullable text column. NULL on every fastrack for a course
--   without the support_role step. No schema_version bump (additive).
--   Rollback = drop column.

-- UP
ALTER TABLE leads.fastrack_submissions ADD COLUMN IF NOT EXISTS support_role_reconfirmed text NULL;
COMMENT ON COLUMN leads.fastrack_submissions.support_role_reconfirmed IS
  'Support-role fastrack: sector the learner reconfirmed at fastrack time. social_care / justice / substance_misuse / other_support (pass) / none (hard DQ). NULL on courses without the support_role gate. Added 2026-07-20.';

-- DOWN
-- ALTER TABLE leads.fastrack_submissions DROP COLUMN IF EXISTS support_role_reconfirmed;
