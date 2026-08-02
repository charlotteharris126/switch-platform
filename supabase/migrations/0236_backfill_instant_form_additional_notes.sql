-- Migration 0236 — backfill leads.submissions.additional_notes for pre-mapping employer leads
-- Date: 2026-08-02
-- Author: Claude (switchable/site session) with owner sign-off
-- Reason: The Riverside S4B Meta Instant Form free-text question was not mapped
--   through Make until 2026-08-02, so employer leads before the fix landed with
--   NULL additional_notes. Owner retrieved the free-text answers from Meta Lead
--   Center and is backfilling them. Richard Payne (743, on-site lead) combines
--   its existing "Upskilling" note with the Instant Form free text per owner
--   (option b); his Instant Form duplicate #747 was already deleted.
-- Impact: data fix, five rows, into an existing nullable text column. No consumer
--   breaks. Values sourced from Meta by the owner. One-off, not reusable.
-- Related: platform/docs/changelog.md; meta-instant-employer-lead-router;
--   _shared/employer-lead-core.ts (additional_notes).

-- UP
UPDATE leads.submissions SET additional_notes = 'Quality of applicants'
  WHERE id = 745 AND source_form = 's4b-employer-lead-meta-instant-v1';
UPDATE leads.submissions SET additional_notes = 'Leadership gaps'
  WHERE id = 746 AND source_form = 's4b-employer-lead-meta-instant-v1';
UPDATE leads.submissions SET additional_notes = 'Productivity'
  WHERE id = 749 AND source_form = 's4b-employer-lead-meta-instant-v1';
UPDATE leads.submissions SET additional_notes = 'Keeping going in a secter that challenging'
  WHERE id = 750 AND source_form = 's4b-employer-lead-meta-instant-v1';
UPDATE leads.submissions SET additional_notes = 'Upskilling / Hiring experienced good people'
  WHERE id = 743;

-- DOWN
-- UPDATE leads.submissions SET additional_notes = NULL WHERE id IN (745, 746, 749, 750);
-- UPDATE leads.submissions SET additional_notes = 'Upskilling' WHERE id = 743;
