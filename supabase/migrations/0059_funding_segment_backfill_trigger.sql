-- Migration 0059 — Iris stage 1e: funding_segment backfill + auto-derive trigger
-- Date: 2026-05-03
-- Author: Claude (Sasha session) with owner review
-- Reason: ads_switchable.meta_daily.funding_segment is currently NULL on every
--   row (verified: 0 distinct values across 101 rows). Owner needs this
--   populated so /admin/ads can filter the performance table by funding
--   segment (stage 4). Two-part fix:
--     1. Backfill existing rows from campaign_name parsing.
--     2. BEFORE INSERT/UPDATE trigger so future ingests stay correct without
--        the Edge Function needing to know the parsing rule. Single source of
--        truth for the campaign-name → funding_segment mapping lives in the
--        trigger function.
--
--   Mapping (extracted from current campaign naming convention):
--     SW-FUND-*  → 'funded'        (Skills Bootcamp, AEB, FCFJ — fully funded)
--     SW-PAID-*  → 'self-funded'   (paid-direct learner)
--     SW-LOAN-*  → 'loan-funded'   (Advanced Learner Loan — pattern reserved
--                                   for future use, no campaigns yet)
--     anything else → NULL (do not guess; dashboard filter will show as "Other")
--
--   No CHECK constraint added so unknown patterns degrade gracefully (NULL)
--   rather than blocking ingest if a future campaign breaks convention.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: backfills existing meta_daily.funding_segment values + adds
--      BEFORE INSERT/UPDATE trigger to derive on all future writes.
--   2. Readers affected: /admin/profit (no current consumer of
--      funding_segment, so unaffected today). Future /admin/ads filter (stage
--      4) will start returning real values once it ships.
--   3. Writers: meta-ads-ingest Edge Function — its INSERTs will now have the
--      funding_segment field auto-populated by the trigger regardless of what
--      the function passes. Function code does not need updating.
--   4. Schema version: not affected (column already existed at v1.0; this is
--      a fill, not a contract change).
--   5. Data migration: yes — backfill via UPDATE.
--   6. New role/policy: no.
--   7. Rollback: clear backfilled values + drop trigger in DOWN.
--   8. Sign-off: owner (this session).
--
-- Related:
--   ClickUp 869d4vtz2 (Iris stage 1e)
--   switchable/ads/docs/ads-dashboard-scope.md (stage 1e spec)
-- =============================================================================

BEGIN;

-- 1. Trigger function — derives funding_segment from campaign_name. Runs
--    BEFORE INSERT and BEFORE UPDATE so any external write (Edge Function,
--    manual SQL, future backfill) keeps the column correct.
CREATE OR REPLACE FUNCTION ads_switchable.set_funding_segment_from_campaign()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Always derive from campaign_name. Unknown / NULL campaign_name → NULL
  -- segment so dashboard filter surfaces as "Other" and convention drift
  -- becomes visible rather than silently mislabelled.
  IF NEW.campaign_name LIKE 'SW-FUND-%' THEN
    NEW.funding_segment := 'funded';
  ELSIF NEW.campaign_name LIKE 'SW-PAID-%' THEN
    NEW.funding_segment := 'self-funded';
  ELSIF NEW.campaign_name LIKE 'SW-LOAN-%' THEN
    NEW.funding_segment := 'loan-funded';
  ELSE
    NEW.funding_segment := NULL;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION ads_switchable.set_funding_segment_from_campaign() IS
  'Derives funding_segment from campaign_name on INSERT/UPDATE of meta_daily. SW-FUND-* → funded, SW-PAID-* → self-funded, SW-LOAN-* → loan-funded, anything else → NULL. Single source of truth for the parsing rule. Migration 0059.';

-- 2. Trigger
CREATE TRIGGER trg_meta_daily_funding_segment
  BEFORE INSERT OR UPDATE OF campaign_name, funding_segment
    ON ads_switchable.meta_daily
  FOR EACH ROW
  EXECUTE FUNCTION ads_switchable.set_funding_segment_from_campaign();

-- 3. Backfill existing rows. The trigger fires when funding_segment is
--    targeted by an UPDATE; explicitly assigning it (even to NULL) guarantees
--    re-derivation from the current campaign_name on every row.
UPDATE ads_switchable.meta_daily SET funding_segment = NULL;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP TRIGGER IF EXISTS trg_meta_daily_funding_segment ON ads_switchable.meta_daily;
-- DROP FUNCTION IF EXISTS ads_switchable.set_funding_segment_from_campaign();
-- UPDATE ads_switchable.meta_daily SET funding_segment = NULL;
-- COMMIT;
