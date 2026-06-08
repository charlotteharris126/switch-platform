-- Migration 0200 — add leads.submissions.earnings_band
-- Date: 2026-06-08
-- Author: Claude (Sasha/platform) with owner sign-off
-- Reason: new funded course "Introduction to Management" (NCFE L2 Team Leading,
--   EMS, Sunderland, course_id team-leading) adds an income gate. The funded form
--   now emits earnings_band (under_30k passes / over_30k DQ'd at the gate). Persist
--   the declared band so it routes to EMS as eligibility evidence. Page not live yet
--   (held on EMS funding-scheme-name confirmation), so this readies the pipeline.
--   Per Mable's push 2026-06-08 (platform handoff). Additive (data-infra §2, free).
-- Impact (§8): additive nullable column on leads.submissions. readonly_analytics
--   still has raw SELECT on the table (legacy per §6a), so the column is auto-readable
--   for reporting (quasi-identifier, not PII). No existing consumer reads it yet.
--   Producer = the funded form (netlify-lead-router via _shared/route-lead.ts).
--   schema_version: producer doc updated additively, no bump. Rollback = drop column.

-- UP
ALTER TABLE leads.submissions ADD COLUMN IF NOT EXISTS earnings_band text NULL;
COMMENT ON COLUMN leads.submissions.earnings_band IS
  'Declared income band from the funded earnings qualifier step. under_30k (passes) / over_30k (DQ at gate). Added 2026-06-08 for the EMS team-leading income gate.';

-- DOWN
-- ALTER TABLE leads.submissions DROP COLUMN IF EXISTS earnings_band;
