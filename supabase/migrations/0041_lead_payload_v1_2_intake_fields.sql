-- Migration 0041 — lead payload schema 1.2: cohort intake capture
-- Date: 2026-04-29
-- Author: Claude (platform session) with owner sign-off
-- Reason: Switchable site shipped form schema 1.2 today with new hidden
-- inputs `preferred_intake_id` and `acceptable_intake_ids` for multi-cohort
-- pages (counselling 6 May + 2 Jun, SMM 21 + 26 May). Without these columns
-- the values land in raw_payload but are silently dropped from the canonical
-- submission row, so the provider sheet has no way to surface which cohort
-- the learner picked.
--
-- Both columns nullable: single-cohort and rolling-intake submissions don't
-- populate them. Per .claude/rules/schema-versioning.md, additive changes
-- are free; lead payload version is bumped at the form (1.0 → 1.2) but
-- this migration doesn't bump anything in the DB beyond adding columns.
--
-- Deferred to a later migration: `confirmed_intake_id` on leads.routing_log
-- (only needed when owner overrides learner's pick at confirm time —
-- currently no surface for that), and `intake_id` on crm.enrolments (only
-- needed for per-cohort enrolment reporting). Both flagged in
-- platform/docs/data-architecture.md.
--
-- Related: switchable/site/docs/funded-funnel-architecture.md (multi-cohort
-- spec), switchable/site/deploy/template/funded-course.html (form inputs).

-- UP

ALTER TABLE leads.submissions
  ADD COLUMN preferred_intake_id    TEXT,
  ADD COLUMN acceptable_intake_ids  TEXT[];

COMMENT ON COLUMN leads.submissions.preferred_intake_id IS
  'Cohort id the learner picked first when offered multiple (e.g. tv-may-06). Equals the only available cohort id on single-cohort pages, NULL on rolling-intake pages. Set by the form (schema 1.2+).';

COMMENT ON COLUMN leads.submissions.acceptable_intake_ids IS
  'Every cohort the learner said yes to. Single-entry array on single-cohort pages, can hold N entries when learner ticks multiple, NULL on rolling-intake pages. Set by the form (schema 1.2+).';

-- Existing column grants on leads.submissions cascade to new columns.
-- functions_writer already has INSERT/UPDATE on the table (per migration
-- 0001 / 0011 grants); readonly_analytics already has SELECT.

-- DOWN
-- ALTER TABLE leads.submissions
--   DROP COLUMN acceptable_intake_ids,
--   DROP COLUMN preferred_intake_id;
