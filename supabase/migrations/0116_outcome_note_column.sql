-- Migration 0116 — add crm.enrolments.outcome_note (free-text)
-- Date:    2026-05-11
-- Author:  Claude (platform Session 40) with owner sign-off
-- Reason:  Provider portal currently forces every Lost outcome into one
--          of seven fixed reasons (not_interested, wrong_course,
--          funding_issue, cancelled, withdrew_after_enrolment,
--          l3_mismatch_self_reported, cohort_decline, other). Real
--          conversations land in nuance the enum can't capture
--          ("learner says next year maybe", "switched provider mid-call",
--          "moved house, asked to be removed"). Adds an optional
--          free-text column that the provider can fill alongside the
--          structured reason. Structured reason stays for analytics +
--          filtering; the note enriches the row when needed.
--
--          Applies to both Lost and Cannot reach outcomes (any closeout
--          benefits from operator nuance). Open / attempt_X / Meeting
--          booked / Enrolled don't expose the note field — those are
--          progress states where the next move is the natural place
--          for context, not a frozen note.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: 1 nullable TEXT column added to crm.enrolments. Additive.
--   2. Readers: provider portal lead detail (renders the note),
--      admin lead detail (will render). Sheet drift detection unaffected
--      (note is not part of drift comparison; sheet has no equivalent
--      column). Brevo unaffected.
--   3. Writers: markOutcomeAction (provider portal Server Action),
--      markEnrolmentOutcomeAction (admin Server Action) — both updated
--      in the same release to accept + persist the note.
--   4. Schema version: not affected (additive column, no payload
--      change, no consumer needs to bump).
--   5. Data migration: none (column is nullable, existing rows get NULL).
--   6. Role/policy: existing crm.enrolments RLS policies (migration 0096)
--      already permit provider_admin / provider_user UPDATE on their own
--      provider's rows. The new column piggybacks the existing UPDATE
--      grant; no new policy needed.
--   7. Rollback: ALTER TABLE DROP COLUMN (in DOWN section). No data loss
--      concern since column is purely additive.
--   8. Sign-off: owner (this session, 2026-05-11).
--
-- Related:
--   platform/app/app/provider/leads/[id]/outcome-buttons.tsx (UI)
--   platform/app/app/provider/leads/[id]/actions.ts (Server Action)

-- UP

ALTER TABLE crm.enrolments
  ADD COLUMN outcome_note TEXT;

COMMENT ON COLUMN crm.enrolments.outcome_note IS
  'Optional free-text note captured at outcome time. Provider portal exposes this when marking Lost / Cannot reach; admin can edit. Distinct from crm.enrolments.notes (legacy single-blob) and crm.lead_notes (the new append-only log). outcome_note is a single durable note attached to the current outcome state — overwritten when the outcome changes (e.g. Lost → Cannot reach loses the prior note). Use crm.lead_notes for history; this column is for "what specifically happened with this outcome".';

-- DOWN
-- ALTER TABLE crm.enrolments DROP COLUMN outcome_note;
