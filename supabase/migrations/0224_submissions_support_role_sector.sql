-- Migration 0224 — add leads.submissions.support_role_sector
-- Date: 2026-07-20
-- Author: Claude (Mable/switchable-site) with owner sign-off
-- Reason: new funded course "Counselling Skills" for support roles (L3 Diploma
--   in Counselling Skills, EMS, South Tyneside, page slug
--   counselling-skills-support-roles-south-tyneside) adds a support-role gate.
--   Unlike age / prior_level_3 / employment / earnings, this is a course ENTRY
--   requirement rather than a funding gate: the learner must already work in a
--   support or guidance role. The funded form now emits support_role_sector
--   (social_care | justice | substance_misuse | other_support pass;
--   none DQ'd at the gate). It is the single most useful qualifying fact on
--   this course, so without persistence the provider receives a lead with no
--   indication of which sector the learner works in. Per Mable's push
--   2026-07-20 (platform handoff). Mirrors 0200 (earnings_band) exactly.
--   Additive (data-infra §2, free).
-- Impact (§8): additive nullable column on leads.submissions. readonly_analytics
--   still has raw SELECT on the table (legacy per §6a), so the column is
--   auto-readable for reporting (quasi-identifier, not PII). No existing consumer
--   reads it yet. Producer = the funded form (netlify-lead-router via
--   _shared/route-lead.ts). Consumers to follow: provider portal lead detail and
--   admin lead detail. schema_version: producer doc updated additively
--   (switchable/site/docs/funded-funnel-architecture.md), no bump.
--   Rollback = drop column.

-- UP
ALTER TABLE leads.submissions ADD COLUMN IF NOT EXISTS support_role_sector text NULL;
COMMENT ON COLUMN leads.submissions.support_role_sector IS
  'Declared support/guidance sector from the funded support_role qualifier step. social_care / justice / substance_misuse / other_support (all pass) / none (DQ at gate). NULL on courses without the step. Added 2026-07-20 for the EMS counselling support-roles gate.';

-- DOWN
-- ALTER TABLE leads.submissions DROP COLUMN IF EXISTS support_role_sector;
