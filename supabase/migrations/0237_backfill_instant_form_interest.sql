-- Migration 0237 — backfill leads.submissions.interest (funding-use) for pre-mapping Instant Form leads
-- Date: 2026-08-02
-- Author: Claude (switchable/site session) with owner sign-off
-- Reason: The Riverside S4B Meta Instant Form "what would you use the funding for?"
--   question was not mapped to `interest` in Make until 2026-08-02, so earlier
--   employer leads had NULL interest. Owner supplied the answers from Meta.
--   Stored as Meta option slugs to match live capture: "upskilling_existing"
--   confirmed from the lead bundle; "both" confirmed from on-site lead 743.
--   750 ("Not sure yet") -> "not_sure_yet" is inferred from the slug pattern
--   (the one value not yet seen from a live lead); trivially correctable.
--   743 (Richard) already held "both" from the on-site form, left unchanged.
--   751 (archived owner-test duplicate of 754) skipped.
-- Impact: data fix, 5 rows, existing nullable text column. No consumer breaks.
-- Related: platform/docs/changelog.md; 0236 (additional_notes backfill).

-- UP
UPDATE leads.submissions SET interest = 'both'
  WHERE id = 745 AND source_form = 's4b-employer-lead-meta-instant-v1';
UPDATE leads.submissions SET interest = 'upskilling_existing'
  WHERE id = 746 AND source_form = 's4b-employer-lead-meta-instant-v1';
UPDATE leads.submissions SET interest = 'upskilling_existing'
  WHERE id = 749 AND source_form = 's4b-employer-lead-meta-instant-v1';
UPDATE leads.submissions SET interest = 'not_sure_yet'
  WHERE id = 750 AND source_form = 's4b-employer-lead-meta-instant-v1';
UPDATE leads.submissions SET interest = 'upskilling_existing'
  WHERE id = 754 AND source_form = 's4b-employer-lead-meta-instant-v1';

-- DOWN
-- UPDATE leads.submissions SET interest = NULL WHERE id IN (745, 746, 749, 750, 754);
