-- Migration 0089 — Add fastrack DQ values to crm.enrolments.lost_reason
-- Date: 2026-05-07
-- Author: Claude (Bit / platform Session 34) with owner sign-off
-- Reason: Fastrack form (lead-to-enrol uplift Phase 2) introduces two
--   operational DQ paths that auto-mark the lead lost with a new
--   lost_reason value:
--     - 'l3_mismatch_self_reported': learner reconfirms a Level 3 on the
--       fastrack eligibility check after having declared "no L3" on the
--       parent funded form. FCFJ ineligible.
--     - 'cohort_decline': learner declines this cohort's fixed start
--       dates. Funded courses run fixed cohorts, not rolling intake, so
--       a "no" is operationally a not-this-round signal.
--   Both fire from the new fastrack-receive Edge Function. Migration 0087
--   ships the leads.fastrack_submissions table; this migration extends
--   the lost_reason CHECK so the Edge Function's DQ writes don't trip
--   the constraint when it auto-updates the matched crm.enrolments row.
--   Pre-flight requirement called out in the platform Session 34 PUSH
--   FROM block.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: additive only. Two values added to the CHECK allowed-set.
--      No table shape change. No data migration. No row writes.
--   2. Readers affected: dashboard / Metabase queries that group by
--      lost_reason will eventually surface the new values once DQ writes
--      start landing. No breakage from values being permitted but absent.
--   3. Writers affected: fastrack-receive Edge Function (deploys after
--      this migration lands). No existing writer emits either value.
--   4. Schema version: no payload-contract change. Internal CHECK
--      expansion only.
--   5. Data migration: none.
--   6. Role / policy: none.
--   7. Rollback: DOWN reverts to the 0082 array. PRECONDITION before
--      running DOWN — zero rows carry the new values, otherwise the
--      ADD CONSTRAINT step rejects the existing data and the DOWN
--      transaction aborts. Verify before running DOWN.
--   8. Sign-off: owner (Session 34, 2026-05-07).
--
-- Related:
--   platform/supabase/migrations/0082_lost_reason_constraint_expansion.sql (prior expansion)
--   platform/supabase/migrations/0087_fastrack_submissions.sql (table the new values serve)
--   switchable/site/docs/funded-funnel-architecture.md (Edge Function pipeline + DQ paths)

BEGIN;

ALTER TABLE crm.enrolments DROP CONSTRAINT IF EXISTS enrolments_lost_reason_chk;

ALTER TABLE crm.enrolments
  ADD CONSTRAINT enrolments_lost_reason_chk
  CHECK (
    lost_reason IS NULL
    OR lost_reason = ANY (ARRAY[
      'not_interested',
      'wrong_course',
      'funding_issue',
      'cancelled',
      'withdrew_after_enrolment',
      'l3_mismatch_self_reported',
      'cohort_decline',
      'other'
    ])
  );

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- PRECONDITION: SELECT count(*) FROM crm.enrolments
--                WHERE lost_reason IN ('l3_mismatch_self_reported','cohort_decline');
--               must return 0 before running this DOWN, or the ADD CONSTRAINT
--               step rejects existing rows and the transaction aborts.
--
-- BEGIN;
-- ALTER TABLE crm.enrolments DROP CONSTRAINT IF EXISTS enrolments_lost_reason_chk;
-- ALTER TABLE crm.enrolments
--   ADD CONSTRAINT enrolments_lost_reason_chk
--   CHECK (
--     lost_reason IS NULL
--     OR lost_reason = ANY (ARRAY[
--       'not_interested',
--       'wrong_course',
--       'funding_issue',
--       'cancelled',
--       'withdrew_after_enrolment',
--       'other'
--     ])
--   );
-- COMMIT;
