-- Migration 0082 — expand crm.enrolments.lost_reason allowed values
-- Date:    2026-05-06
-- Author:  Claude (platform Session 33) on Charlotte's request
-- Reason:  Today's Lucy Hizmo cancellation (data-ops/015) used
--          lost_reason='other' because 'cancelled' wasn't allowed by the
--          existing CHECK constraint. The existing taxonomy was:
--            not_interested, wrong_course, funding_issue, other
--          That covered pre-enrolment dropout reasons but missed two real
--          post-enrolment outcomes — cancellation (learner changed mind
--          before starting) and withdrawal (learner enrolled then dropped
--          out partway). Both are operationally meaningful and worth
--          tracking distinctly from 'other' for cohort retention analytics.
--
--          Adds two values: 'cancelled' and 'withdrew_after_enrolment'.
--          Pre-existing rows tagged 'other' with cancellation context in
--          notes (only Lucy at the time of writing) are reclassified here.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: drop + recreate CHECK constraint with two new allowed values.
--      Backfill one row (Lucy, enrolment 1) to use the proper value.
--   2. Readers: dashboard /admin/analytics + Mira's audit could segment
--      lost-by-reason. No reader currently breaks on a new enum value;
--      they read whatever's there.
--   3. Writers: enrolment-outcome-form on lead detail page; Channel B sheet-
--      mirror via pending_updates. Both pass-through whatever lost_reason
--      the user picks. New values will be added to the dropdown on the form
--      in a follow-up app commit (separate from this migration).
--   4. Schema version: not affected (additive enum expansion).
--   5. Data migration: yes, one-row update for Lucy. Idempotent — if she's
--      already been updated by hand the WHERE clause won't match.
--   6. Role/policy: no change.
--   7. Rollback: if needed, drop constraint and re-add with old taxonomy.
--      Rows holding the new values would need reclassifying first.
--   8. Sign-off: owner (this session).
--
-- Related: platform/supabase/data-ops/015_lana_lucy_status_correction.sql

-- UP

ALTER TABLE crm.enrolments DROP CONSTRAINT enrolments_lost_reason_chk;

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
      'other'
    ])
  );

-- Reclassify Lucy's row from the placeholder 'other' to the proper 'cancelled'
-- value now that it's permitted. Only updates if her row still carries the
-- placeholder and the cancellation marker in notes (idempotent).
UPDATE crm.enrolments
   SET lost_reason = 'cancelled',
       updated_at = now()
 WHERE id = 1
   AND lost_reason = 'other'
   AND notes ILIKE '%Cancelled by learner%';

-- DOWN
-- ALTER TABLE crm.enrolments DROP CONSTRAINT enrolments_lost_reason_chk;
-- ALTER TABLE crm.enrolments
--   ADD CONSTRAINT enrolments_lost_reason_chk
--   CHECK (lost_reason IS NULL OR lost_reason = ANY (ARRAY['not_interested','wrong_course','funding_issue','other']));
-- (Pre-rollback: UPDATE crm.enrolments SET lost_reason='other' WHERE lost_reason IN ('cancelled','withdrew_after_enrolment'); )
