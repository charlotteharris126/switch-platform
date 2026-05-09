-- Migration 0092 — Drop legacy enrolments_status_chk constraint
-- Date:    2026-05-08
-- Author:  Claude (platform Session 36) on Charlotte's instruction
-- Reason:  Migration 0091 added the new CHECK constraint (enrolments_status_check)
--          with the expanded status taxonomy, but its DROP IF EXISTS targeted
--          the wrong name — the existing legacy CHECK was named
--          enrolments_status_chk (no 'e' on 'chk'), inherited from migration
--          0028. Both constraints were left active, so any insert of a new
--          status value (attempt_1_no_answer / attempt_2_no_answer /
--          attempt_3_no_answer / enrolment_meeting_booked) would PASS the new
--          CHECK but FAIL the old one and be rejected. This migration drops
--          the legacy constraint so the new taxonomy is the only one
--          enforced.
--
--          Lesson logged: query pg_constraint live before writing DROP statements.
-- Related: migration 0091 (added enrolments_status_check)
--          migration 0028 (originally created enrolments_status_chk)

-- UP

ALTER TABLE crm.enrolments
  DROP CONSTRAINT IF EXISTS enrolments_status_chk;

-- DOWN
-- Restore the legacy CHECK with the pre-0091 taxonomy. Will fail to apply
-- if any rows have one of the new statuses (attempt_*, enrolment_meeting_booked);
-- those would need to be migrated back to a legacy value first.
--
-- ALTER TABLE crm.enrolments ADD CONSTRAINT enrolments_status_chk
--   CHECK (status IN ('open', 'enrolled', 'presumed_enrolled', 'cannot_reach', 'lost'));
