-- Migration 0151 — enrolments_status_check includes employer statuses
-- Date: 2026-05-19
-- Author: Claude (Sasha session) with owner review
-- Reason:
--   Freya (Riverside) hit "new row for relation 'enrolments' violates
--   check constraint 'enrolments_status_check'" when trying to mark a
--   lead as Engaged from the provider portal on 2026-05-19.
--
--   crm.enrolments.status had its CHECK rebuilt in migration 0091 for
--   the provider portal MVP, listing only learner statuses:
--     open / attempt_1/2/3_no_answer / enrolment_meeting_booked /
--     enrolled / lost / cannot_reach / presumed_enrolled
--
--   Migration 0126 later extended the admin RPC crm.upsert_enrolment_outcome
--   to accept the employer statuses (engaged / in_progress / signed /
--   not_signed / presumed_employer_signed) — but the underlying CHECK
--   on the table was never widened to match. The provider portal's
--   markOutcomeAction (app/app/provider/leads/[id]/actions.ts) writes
--   to crm.enrolments via a direct supabase.update() call, not through
--   the admin RPC, so the table-level CHECK is the gate Freya's click
--   actually hits.
--
--   This migration drops and rebuilds the CHECK with the full learner +
--   employer taxonomy. Same taxonomy as the 0126 RPC whitelist — keeps
--   the constraint and the RPC in lockstep.
--
-- Impact assessment:
--   1. Change: replace enrolments_status_check with extended IN list.
--   2. Readers: every consumer that filters or branches on status —
--      provider portal lead-detail + leads-table (already handles
--      employer statuses, see EmployerOutcomeButtons + leads-table
--      filter pills); admin /admin/leads (renders status badge from
--      enrolmentBySubId, employer values already in the status union);
--      crm.vw_enrolments_chaser_state (status-agnostic, only filters
--      on email_type); crm.vw_provider_billing_state_per_provider
--      (already counts engaged / in_progress / signed / not_signed
--      per migration 0132). No downstream view broken by widening.
--   3. Writers: provider portal markOutcomeAction (direct UPDATE), admin
--      crm.upsert_enrolment_outcome (RPC), platform Edge Functions
--      that write status (route-lead seeds 'open', auto-flip cron sets
--      'presumed_enrolled' / 'presumed_employer_signed').
--   4. Schema versioning: lead payload v1.0 unchanged. This is a
--      pure widening of an existing column's permitted values —
--      additive, no rows invalidated.
--   5. Rollback: restoring the learner-only CHECK requires migrating
--      any rows holding new values back to a legacy status first.
--   6. Sign-off: owner (Charlotte), 2026-05-19.
--
-- Related:
--   migration 0091 (added the learner-only enrolments_status_check)
--   migration 0092 (dropped the legacy enrolments_status_chk)
--   migration 0126 (extended the admin RPC whitelist — same taxonomy)
--   migration 0132 (vw_provider_billing_state_per_provider — already
--   references employer statuses, so the view was written against the
--   intended taxonomy ahead of the table constraint catching up)

-- UP

ALTER TABLE crm.enrolments
  DROP CONSTRAINT IF EXISTS enrolments_status_check;

ALTER TABLE crm.enrolments
  ADD CONSTRAINT enrolments_status_check CHECK (status IN (
    -- Initial state set on routing (both lead types)
    'open',
    -- Learner-lead progression
    'attempt_1_no_answer',
    'attempt_2_no_answer',
    'attempt_3_no_answer',
    'enrolment_meeting_booked',
    'enrolled',
    'lost',
    'cannot_reach',
    'presumed_enrolled',
    -- Employer-lead progression (Switchable for Business v1)
    'engaged',
    'in_progress',
    'signed',
    'not_signed',
    'presumed_employer_signed'
  ));

COMMENT ON CONSTRAINT enrolments_status_check ON crm.enrolments IS
  'Status taxonomy as of 2026-05-19 (migration 0151). Two state machines share one column, disambiguated by leads.submissions.lead_type. Learner: open → attempt_1/2/3_no_answer / enrolment_meeting_booked → enrolled / lost / cannot_reach / presumed_enrolled (system-set day-14 auto-flip). Employer: open → engaged → in_progress → signed / not_signed / presumed_employer_signed (system-set day-60 auto-flip).';

-- DOWN
-- Restoring the learner-only CHECK requires migrating any rows holding
-- one of engaged / in_progress / signed / not_signed / presumed_employer_signed
-- back to a legacy value (or 'open') before the constraint can be re-added.
--
-- ALTER TABLE crm.enrolments DROP CONSTRAINT enrolments_status_check;
-- ALTER TABLE crm.enrolments ADD CONSTRAINT enrolments_status_check
--   CHECK (status IN ('open', 'attempt_1_no_answer', 'attempt_2_no_answer',
--                     'attempt_3_no_answer', 'enrolment_meeting_booked',
--                     'enrolled', 'lost', 'cannot_reach', 'presumed_enrolled'));
