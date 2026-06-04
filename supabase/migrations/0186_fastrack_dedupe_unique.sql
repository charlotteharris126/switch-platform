-- Migration 0186 — stop duplicate fastrack submissions (double-submit guard)
-- Date: 2026-06-03
-- Author: Claude (platform session) with owner review
-- Reason: the fastrack thank-you page intermittently double-POSTs, so
--   fastrack-receive ran twice and created two identical leads.fastrack_submissions
--   rows (same parent_submission_id + same client-supplied submitted_at, to the
--   millisecond) — and fired the provider notification email twice. Examples:
--   parents 552, 557, 564. Fix: dedupe existing pairs, then a unique index so a
--   repeat POST can't insert a second row. The EF uses ON CONFLICT DO NOTHING and
--   treats the conflict as an idempotent no-op (no second notification).
--   A genuine later re-fill has a different submitted_at, so it's still allowed.
--
-- Impact: removes exact-duplicate fastrack rows (keeps lowest id). The provider
--   portal + detail view read fastrack via a Set of parent ids / LIMIT 1, so
--   de-duping changes no displayed data. New unique index. No payload contract
--   change (submitted_at already part of the lead/fastrack payload).
-- Rollback: drop the index (cannot un-delete the duplicate rows, but they were
--   exact copies — no information lost).
-- Related: supabase/functions/fastrack-receive/index.ts

-- UP

-- Remove existing exact-duplicate rows, keeping the earliest id per (parent, submitted_at).
DELETE FROM leads.fastrack_submissions a
USING leads.fastrack_submissions b
WHERE a.parent_submission_id = b.parent_submission_id
  AND a.submitted_at = b.submitted_at
  AND a.id > b.id;

-- Block future exact double-submits. NULL submitted_at rows are treated as
-- distinct by the index (acceptable — the form always sends submitted_at).
CREATE UNIQUE INDEX IF NOT EXISTS fastrack_submissions_parent_submitted_uniq
  ON leads.fastrack_submissions (parent_submission_id, submitted_at);

-- DOWN
-- DROP INDEX IF EXISTS leads.fastrack_submissions_parent_submitted_uniq;
