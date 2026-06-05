-- Migration 0187 — allow employer "not signed" reasons in enrolments.lost_reason
-- Date: 2026-06-04
-- Author: Claude (platform session) with owner review
-- Reason: Freya (Riverside) reported that "Mark not signed" with the "No response"
--   reason errors and bounces back. Root cause: the provider portal validates the
--   reason against the app enum VALID_NOT_SIGNED_REASONS (lib/lead-status.ts) and
--   writes it to crm.enrolments.lost_reason, but the lost_reason CHECK constraint
--   only permits the learner "lost" reasons + the two fastrack auto-DQ reasons. So
--   EVERY employer not_signed reason except 'other' (budget, wrong_levy_fit, timing,
--   competitor, decided_not_to_proceed, no_response) is rejected by the DB → the
--   UPDATE fails → the server action errors → the page reverts. The app enum and the
--   DB constraint drifted apart. This widens the constraint to match the app enum.
--
-- Impact assessment:
--   - Change: widen the lost_reason CHECK to also allow the 6 employer not_signed
--     reasons. Purely additive (no value removed). No existing rows are invalid
--     (the constraint blocked them from ever being written).
--   - Reads of lost_reason: provider portal display + reporting — additive, nothing
--     breaks. Writes: unblocks markOutcomeAction for employer not_signed.
--   - schema_version: n/a (internal outcome field, not an ingested payload column).
--   - Rollback: restore the prior constraint (in DOWN).
-- Related: platform/app/lib/lead-status.ts (VALID_NOT_SIGNED_REASONS),
--   platform/app/app/provider/leads/[id]/actions.ts, migration 0089.

-- UP
ALTER TABLE crm.enrolments DROP CONSTRAINT enrolments_lost_reason_chk;
ALTER TABLE crm.enrolments ADD CONSTRAINT enrolments_lost_reason_chk
  CHECK (
    lost_reason IS NULL
    OR lost_reason = ANY (ARRAY[
      -- learner "lost" reasons
      'not_interested', 'wrong_course', 'funding_issue', 'cancelled', 'withdrew_after_enrolment',
      -- fastrack auto-DQ reasons (migration 0089)
      'l3_mismatch_self_reported', 'cohort_decline',
      -- employer "not signed" reasons (lib/lead-status.ts VALID_NOT_SIGNED_REASONS)
      'budget', 'wrong_levy_fit', 'timing', 'competitor', 'decided_not_to_proceed', 'no_response',
      -- shared
      'other'
    ]::text[])
  );

-- DOWN
-- ALTER TABLE crm.enrolments DROP CONSTRAINT enrolments_lost_reason_chk;
-- ALTER TABLE crm.enrolments ADD CONSTRAINT enrolments_lost_reason_chk
--   CHECK (lost_reason IS NULL OR lost_reason = ANY (ARRAY[
--     'not_interested','wrong_course','funding_issue','cancelled','withdrew_after_enrolment',
--     'l3_mismatch_self_reported','cohort_decline','other']::text[]));
