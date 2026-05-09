-- Migration 0099 — Waitlist enrichment columns + extended Brevo-sync trigger
-- Date:    2026-05-09
-- Author:  Claude (platform Session 36) on Charlotte's instruction
-- Reason:  Mable's fastrack cohort_decline UX redirects to /waitlist/ which
--          submits a switchable-waitlist-enrichment form with hidden fields
--          carrying parent_ref + source_form + 5 enrichment fields. The
--          original assumption was that the enrichment fields landed in DB
--          when the original funded-DQ enrichment shipped, but they didn't —
--          only `phone` exists. This migration adds the 4 missing columns
--          plus source_form (tracks which entry surface fired the
--          enrichment) and enriched_at (timestamp).
--
--          Plus extends the leads.tg_submissions_brevo_sync trigger from
--          migration 0098 to fire on changes to: the new columns, plus
--          fastracked_at (which fastrack-receive sets and 0098's original
--          WHEN clause missed). This means SW_FASTRACK_COMPLETED + the 5
--          enrichment SW_* attributes auto-sync to Brevo on any change.
--
--          Wren's naming locked (defaults — Wren can rename later via Brevo
--          dashboard, low cost):
--            SW_PHONE, SW_START_TIMING, SW_INTEREST_BREADTH,
--            SW_INVESTMENT_WILLINGNESS, SW_CURRENT_QUALIFICATION,
--            SW_LOST_REASON, SW_FASTRACK_COMPLETED
--
--          Owner step after this migration applies + code deploys:
--          create the 7 attributes in Brevo dashboard. Resync existing
--          routed cohort to backfill.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: 6 new nullable columns + extended trigger function. No
--      data migration. Existing rows get NULL on the new fields.
--   2. Readers: future readers — admin dashboard if it surfaces waitlist
--      enrichment, route-lead.ts (this session's code change) for Brevo push.
--   3. Writers: ingest.ts (this session's code change) captures from
--      switchable-waitlist-enrichment payloads.
--   4. Schema version: lead payload contract gains optional fields in the
--      enrichment branch. Per `.claude/rules/schema-versioning.md`, additive
--      optional fields don't bump version. Documented in funded-funnel-
--      architecture.md without a bump.
--   5. Data migration: none.
--   6. Role/policy: same grants as the rest of leads.submissions.
--   7. Rollback: DROP COLUMNs + restore prior trigger function body.
--   8. Sign-off: owner (this session, 2026-05-09).
-- Related: migration 0026 (lead dedup), 0087 (fastrack columns), 0098
--          (the trigger this extends), Mable's fastrack cohort_decline
--          ask 2026-05-09, switchable/email/docs/brevo-attribute-architecture.md

BEGIN;

-- =============================================================================
-- 1. New columns on leads.submissions
-- =============================================================================

ALTER TABLE leads.submissions
  ADD COLUMN IF NOT EXISTS start_timing             TEXT,
  ADD COLUMN IF NOT EXISTS interest_breadth         TEXT,
  ADD COLUMN IF NOT EXISTS investment_willingness   TEXT,
  ADD COLUMN IF NOT EXISTS current_qualification    TEXT,
  ADD COLUMN IF NOT EXISTS source_form              TEXT,
  ADD COLUMN IF NOT EXISTS enriched_at              TIMESTAMPTZ;

COMMENT ON COLUMN leads.submissions.start_timing IS
  'When the learner says they could start the course. Captured by switchable-waitlist-enrichment form. Free-text values from form chips: e.g. "asap", "few-months", "later", "exploring". Pushed to Brevo as SW_START_TIMING. Added migration 0099.';

COMMENT ON COLUMN leads.submissions.interest_breadth IS
  'How broad the learner''s interest is across courses. Captured by switchable-waitlist-enrichment. Free-text values: e.g. "specific", "broad", "exploring". Pushed to Brevo as SW_INTEREST_BREADTH. Added migration 0099.';

COMMENT ON COLUMN leads.submissions.investment_willingness IS
  'Budget signal from switchable-waitlist-enrichment form. Free-text values: e.g. "200-500", "500-1000", "over-1000", "not-sure". Pushed to Brevo as SW_INVESTMENT_WILLINGNESS. Added migration 0099.';

COMMENT ON COLUMN leads.submissions.current_qualification IS
  'Learner''s current qualification level signal from switchable-waitlist-enrichment. Free-text values: e.g. "knowledge-only", "skills-cert", "not-sure". Pushed to Brevo as SW_CURRENT_QUALIFICATION. Added migration 0099.';

COMMENT ON COLUMN leads.submissions.source_form IS
  'Which entry surface produced this enrichment row. Lets the receiver disambiguate behaviour by origin. Values: switchable-waitlist (default holding-list path), fastrack-cohort-decline (cohort_decline learners redirected from fastrack thank-you to /waitlist/). Added migration 0099.';

COMMENT ON COLUMN leads.submissions.enriched_at IS
  'Timestamp the enrichment data landed (form submit time for switchable-waitlist-enrichment). NULL on rows that were never enriched. Added migration 0099.';

-- =============================================================================
-- 2. Extend the leads.tg_submissions_brevo_sync trigger to cover new columns
--    plus fastracked_at (which 0098's original WHEN clause missed).
-- =============================================================================

CREATE OR REPLACE FUNCTION leads.tg_submissions_brevo_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm, leads, public
AS $$
BEGIN
  -- Fires only if a Brevo-mapped field changed. Mirrors what _shared/route-lead.ts
  -- pushes as SW_* attributes — this list expands as new attributes are added.
  IF NEW.email IS DISTINCT FROM OLD.email
     OR NEW.first_name IS DISTINCT FROM OLD.first_name
     OR NEW.last_name IS DISTINCT FROM OLD.last_name
     OR NEW.phone IS DISTINCT FROM OLD.phone
     OR NEW.course_id IS DISTINCT FROM OLD.course_id
     OR NEW.funding_category IS DISTINCT FROM OLD.funding_category
     OR NEW.funding_route IS DISTINCT FROM OLD.funding_route
     OR NEW.employment_status IS DISTINCT FROM OLD.employment_status
     OR NEW.outcome_interest IS DISTINCT FROM OLD.outcome_interest
     OR NEW.is_dq IS DISTINCT FROM OLD.is_dq
     OR NEW.dq_reason IS DISTINCT FROM OLD.dq_reason
     OR NEW.archived_at IS DISTINCT FROM OLD.archived_at
     OR NEW.marketing_opt_in IS DISTINCT FROM OLD.marketing_opt_in
     OR NEW.primary_routed_to IS DISTINCT FROM OLD.primary_routed_to
     OR NEW.referral_code IS DISTINCT FROM OLD.referral_code
     OR NEW.preferred_intake_id IS DISTINCT FROM OLD.preferred_intake_id
     OR NEW.interest IS DISTINCT FROM OLD.interest
     -- Added migration 0099: enrichment + fastrack fields
     OR NEW.start_timing IS DISTINCT FROM OLD.start_timing
     OR NEW.interest_breadth IS DISTINCT FROM OLD.interest_breadth
     OR NEW.investment_willingness IS DISTINCT FROM OLD.investment_willingness
     OR NEW.current_qualification IS DISTINCT FROM OLD.current_qualification
     OR NEW.fastracked_at IS DISTINCT FROM OLD.fastracked_at THEN
    PERFORM crm.sync_leads_to_brevo(ARRAY[NEW.id]);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION leads.tg_submissions_brevo_sync() IS
  'AFTER UPDATE trigger function on leads.submissions. Fires crm.sync_leads_to_brevo(ARRAY[NEW.id]) when any Brevo-mapped field changes. Originally added migration 0098; extended migration 0099 to cover phone, fastracked_at, and 4 enrichment fields (start_timing / interest_breadth / investment_willingness / current_qualification). Async via pg_net.';

-- Trigger binding unchanged — function body update via CREATE OR REPLACE
-- propagates automatically.

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- -- Restore pre-0099 trigger function body (without the new fields):
-- CREATE OR REPLACE FUNCTION leads.tg_submissions_brevo_sync() ...
-- (copy from 0098)
-- ALTER TABLE leads.submissions DROP COLUMN IF EXISTS enriched_at;
-- ALTER TABLE leads.submissions DROP COLUMN IF EXISTS source_form;
-- ALTER TABLE leads.submissions DROP COLUMN IF EXISTS current_qualification;
-- ALTER TABLE leads.submissions DROP COLUMN IF EXISTS investment_willingness;
-- ALTER TABLE leads.submissions DROP COLUMN IF EXISTS interest_breadth;
-- ALTER TABLE leads.submissions DROP COLUMN IF EXISTS start_timing;
-- COMMIT;
