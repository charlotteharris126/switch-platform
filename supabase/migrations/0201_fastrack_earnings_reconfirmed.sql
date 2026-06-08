-- Migration 0201 — add earnings_reconfirmed to leads.fastrack_submissions
-- Date: 2026-06-08
-- Author: Claude (Sasha/platform) with owner sign-off
-- Reason: the AEB fastrack (team-leading) swaps the FCFJ "L3 reconfirm" question
--   for an earnings reconfirm ("yes, I earn under £30k"). It's part of the extra
--   due-diligence that tells EMS the lead is warm, so it must be captured and
--   surfaced to the provider, symmetric with how l3_reconfirmed is for FCFJ.
--   New posted field earnings_reconfirmed (bool, non-PII, additive) from the
--   fastrack-funded-v1 form on AEB pages. fastrack-receive persists it here and
--   includes it in the provider fastrack summary. Pairs with earnings_band (0200).
-- Impact: additive nullable boolean. NULL on FCFJ fastracks (question not asked),
--   set on AEB fastracks. No schema_version bump (additive). Rollback = drop column.

-- UP
ALTER TABLE leads.fastrack_submissions ADD COLUMN IF NOT EXISTS earnings_reconfirmed boolean NULL;
COMMENT ON COLUMN leads.fastrack_submissions.earnings_reconfirmed IS
  'AEB fastrack: learner reconfirmed they earn under £30k. NULL on FCFJ fastracks. Added 2026-06-08.';

-- DOWN
-- ALTER TABLE leads.fastrack_submissions DROP COLUMN IF EXISTS earnings_reconfirmed;
