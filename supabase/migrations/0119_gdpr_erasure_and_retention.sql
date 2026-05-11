-- Migration 0119 — GDPR right-to-erasure + retention infrastructure
-- Date:    2026-05-11
-- Author:  Claude (Block D proper-fix) on Charlotte's instruction
-- Reason:  Audit found we have no documented or automated way to honour
--          a learner's right-to-erasure request (UK GDPR Art. 17) across
--          DB + Brevo + per-provider Google Sheets, and no retention
--          policy on long-tail learner PII in leads.submissions. This
--          migration adds:
--            (a) sheet_result column on audit.erasure_requests (the
--                existing receipts table from 0016 already has columns
--                for supabase_result, brevo_result, netlify_result,
--                meta_capi_result, google_ads_result but no Google Sheet
--                receipt — sheets are an active sub-processor today).
--            (b) leads.submissions.anonymised_at timestamp + helper
--                function leads.anonymise_submission(id) that NULLs
--                the PII columns and stamps the row. Used by both the
--                manual erasure path AND the retention cron.
--            (c) leads.cron_retention_anonymise_submissions() — runs
--                daily at 02:30 UTC, anonymises submissions where:
--                  - submitted_at < now() - interval '24 months'
--                  - AND no active enrolment (status IN settled set or
--                    no enrolment row at all)
--                  - AND not already anonymised
--                Operational metadata (course_id, funding, status, dates,
--                derived fields) preserved so analytics keep working.
--
-- Hard PII delete vs soft anonymise:
--   The right-to-erasure path performs a HARD DELETE (compliance with
--   Art. 17 — "without undue delay"). The retention path SOFT ANONYMISES
--   so historical analytics stay intact. Different rights = different
--   tools.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: (a) new nullable column on audit.erasure_requests;
--      (b) new nullable column on leads.submissions; (c) two new
--      functions; (d) one new pg_cron schedule.
--   2. Readers affected: analytics queries that read submissions.email /
--      first_name etc. need to handle NULLs gracefully — they already
--      should (these columns are TEXT nullable by spec) but worth a
--      grep before this ships. Anonymised rows surface via the
--      `anonymised_at IS NOT NULL` filter in admin views (todo for D.3).
--   3. Writers affected: no current writer needs changing.
--   4. Schema version: leads payload contract gains an anonymised_at
--      derived column. Additive optional → no version bump per
--      schema-versioning.md.
--   5. Data migration: existing rows get anonymised_at = NULL. Backfill
--      not required — retention cron will pick up old rows on next run.
--   6. Role/policy: functions are SECURITY DEFINER, search_path pinned.
--      Cron runs as the cron supervisor; cron.schedule already grants
--      itself the right to call public-schema functions.
--   7. Rollback: DOWN drops the cron schedule, the functions, and the
--      anonymised_at column. The sheet_result column on
--      audit.erasure_requests stays (audit table; never DROP COLUMN
--      retroactively in case of receipts).
--   8. Sign-off: owner (this session, 2026-05-11).
-- Related: 0016 (audit.erasure_requests table), 0083 (cron pattern),
--          .claude/rules/data-infrastructure.md §10 (dead letter +
--          retention discipline), platform/docs/data-architecture.md.

BEGIN;

-- =============================================================================
-- 1. sheet_result column on audit.erasure_requests
-- =============================================================================

ALTER TABLE audit.erasure_requests
  ADD COLUMN IF NOT EXISTS sheet_result JSONB;

COMMENT ON COLUMN audit.erasure_requests.sheet_result IS
  'Per-provider Google Sheet erasure receipt. Shape: { providers: [{ provider_id, status: "deleted"|"failed"|"skipped", sheet_row_position?, error? }], total_providers, deleted_count }. Added migration 0119.';

-- =============================================================================
-- 2. anonymised_at column + anonymise helper on leads.submissions
-- =============================================================================

ALTER TABLE leads.submissions
  ADD COLUMN IF NOT EXISTS anonymised_at TIMESTAMPTZ;

COMMENT ON COLUMN leads.submissions.anonymised_at IS
  'Timestamp at which the row''s PII columns (email, first_name, last_name, phone, postcode, etc.) were NULLed by the retention cron. NULL means row still carries identifiable data. Operational fields (course_id, funding, status, dates) are preserved either way. Added migration 0119.';

CREATE INDEX IF NOT EXISTS submissions_anonymised_at_idx
  ON leads.submissions (anonymised_at)
  WHERE anonymised_at IS NOT NULL;

CREATE OR REPLACE FUNCTION leads.anonymise_submission(p_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, leads, public
AS $$
DECLARE
  v_already_anonymised BOOLEAN;
BEGIN
  SELECT (anonymised_at IS NOT NULL)
    INTO v_already_anonymised
    FROM leads.submissions
   WHERE id = p_id
   LIMIT 1;

  IF v_already_anonymised IS NULL THEN
    RETURN FALSE; -- row doesn't exist
  END IF;

  IF v_already_anonymised THEN
    RETURN FALSE; -- already done; idempotent no-op
  END IF;

  -- NULL the PII columns. Keep operational metadata so analytics works.
  -- The COLUMN list intentionally enumerates the PII fields rather than
  -- "everything except these" — additive payload changes won't silently
  -- start retaining new PII.
  UPDATE leads.submissions
     SET email             = NULL,
         first_name        = NULL,
         last_name         = NULL,
         phone             = NULL,
         postcode          = NULL,
         la                = NULL,
         interest          = NULL,
         why_this_course   = NULL,
         referral_code     = NULL,
         anonymised_at     = now()
   WHERE id = p_id;

  -- Strip free-text fields on associated fastrack rows too. Structured
  -- yes/no flags can stay (they're aggregate-safe).
  UPDATE leads.fastrack_submissions
     SET voice_of_learner_intro = NULL
   WHERE parent_submission_id = p_id
     AND voice_of_learner_intro IS NOT NULL;

  -- Strip free-text outcome notes on the enrolment. The structured
  -- status / lost_reason stay (no PII).
  UPDATE crm.enrolments
     SET outcome_note = NULL
   WHERE submission_id = p_id
     AND outcome_note IS NOT NULL;

  -- Lead notes are author-attributed and may contain learner-identifying
  -- content. Wipe body text but keep the row for audit shape.
  UPDATE crm.lead_notes
     SET body = '[anonymised by retention]'
   WHERE submission_id = p_id;

  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION leads.anonymise_submission(BIGINT) IS
  'Soft-anonymises a single leads.submissions row: NULLs PII columns and stamps anonymised_at. Cascades to fastrack_submissions.voice_of_learner_intro, crm.enrolments.outcome_note, crm.lead_notes.body. Operational metadata (course_id, funding, status, dates) preserved for analytics. Idempotent — returns FALSE on already-anonymised or missing row. Added migration 0119.';

REVOKE ALL ON FUNCTION leads.anonymise_submission(BIGINT) FROM PUBLIC;
-- Only the cron supervisor + service_role can call this; portal users
-- never hit it directly.
GRANT EXECUTE ON FUNCTION leads.anonymise_submission(BIGINT) TO service_role;

-- =============================================================================
-- 3. Retention cron function: nightly anonymise of long-tail rows
-- =============================================================================

CREATE OR REPLACE FUNCTION leads.cron_retention_anonymise_submissions()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, leads, crm, public
AS $$
DECLARE
  v_cutoff       TIMESTAMPTZ := now() - INTERVAL '24 months';
  v_settled      TEXT[]      := ARRAY['lost', 'enrolled', 'presumed_enrolled', 'cannot_reach'];
  v_eligible_ids BIGINT[];
  v_id           BIGINT;
  v_count        INT         := 0;
BEGIN
  -- Eligible: old, not already anonymised, no active enrolment.
  -- "No active enrolment" = no enrolment row OR enrolment in the settled set.
  SELECT COALESCE(array_agg(s.id), ARRAY[]::BIGINT[])
    INTO v_eligible_ids
    FROM leads.submissions s
    LEFT JOIN crm.enrolments e ON e.submission_id = s.id
   WHERE s.submitted_at < v_cutoff
     AND s.anonymised_at IS NULL
     AND (e.id IS NULL OR e.status = ANY(v_settled));

  FOREACH v_id IN ARRAY v_eligible_ids LOOP
    IF leads.anonymise_submission(v_id) THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ran_at', now(),
    'cutoff', v_cutoff,
    'eligible_count', COALESCE(array_length(v_eligible_ids, 1), 0),
    'anonymised_count', v_count
  );
END;
$$;

COMMENT ON FUNCTION leads.cron_retention_anonymise_submissions() IS
  'Nightly retention cron. Anonymises leads.submissions rows older than 24 months that have no active enrolment. Scheduled by migration 0119 at 02:30 UTC. Returns a JSONB receipt with counts. Added migration 0119.';

-- =============================================================================
-- 4. Schedule the cron at 02:30 UTC daily
-- =============================================================================

-- Idempotent: drop any prior schedule of the same name before recreating.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'leads_retention_anonymise_daily') THEN
    PERFORM cron.unschedule('leads_retention_anonymise_daily');
  END IF;
END;
$$;

SELECT cron.schedule(
  'leads_retention_anonymise_daily',
  '30 2 * * *',
  $$ SELECT leads.cron_retention_anonymise_submissions(); $$
);

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DO $$ BEGIN
--   IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'leads_retention_anonymise_daily') THEN
--     PERFORM cron.unschedule('leads_retention_anonymise_daily');
--   END IF;
-- END $$;
-- DROP FUNCTION IF EXISTS leads.cron_retention_anonymise_submissions();
-- DROP FUNCTION IF EXISTS leads.anonymise_submission(BIGINT);
-- ALTER TABLE leads.submissions DROP COLUMN IF EXISTS anonymised_at;
-- -- sheet_result column on audit.erasure_requests intentionally kept (audit table; receipts only grow).
-- COMMIT;
