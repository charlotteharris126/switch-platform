-- Migration 0152 — BEFORE INSERT trigger stamps client_nonce on funded submissions
-- Date: 2026-05-19
-- Author: Claude (Sasha session) with owner review
-- Reason:
--   Migration 0087 (7 May 2026) added leads.submissions.client_nonce so
--   every funded learner could get a per-lead fastrack URL. The form
--   pipeline (route-lead.ts → ingest.ts) stamps a nonce from the form
--   payload's client_nonce field. But the column stays nullable, and the
--   panel-side "025 backfill" exists to mop up funded leads that landed
--   without a nonce — typically because the form payload didn't include
--   one (legacy form snapshot, ad-hoc replay, curl test, future ingestion
--   source). Every Edge Function on the insert path would need the same
--   defensive stamp logic to close this — n insert paths = n places to
--   forget. A DB trigger closes it once, for every path past and future.
--
--   The trigger fires for INSERTs only. It deliberately leaves self-funded
--   and DQ rows nullable because the fastrack URL is funded-only by
--   product design — self / loan-funded routes have their own funnel,
--   employer leads (lead_type='employer_apprenticeship') have no fastrack
--   semantics at all. The condition is funding_category IN ('gov','loan'),
--   matching the audience filter on the 025 backfill function +
--   public.count_client_nonce_pending. If a row's funding_category is
--   later changed to gov/loan via UPDATE, the column will still be NULL —
--   that path is rare enough the backfill / a future drift sweeper can
--   handle it; covering it here would require an additional ON UPDATE
--   path and risks stamping nonces on rows the operator deliberately
--   nulled.
--
-- Impact assessment:
--   1. Change: new trigger fires on INSERT and sets client_nonce =
--      gen_random_uuid() when funding_category is gov/loan and the
--      incoming nonce is NULL. No-op when the caller already supplied
--      a nonce (form path stays in control).
--   2. Readers: route-lead.ts (composeBrevoCourseContext + Brevo
--      attribute writes), fastrack-receive (looks up parent by
--      client_nonce), backfill-referral-fastrack-urls (reads
--      client_nonce to build SW_FASTRACK_URL). All gain consistency,
--      none break.
--   3. Writers: every INSERT path (netlify-lead-router,
--      netlify-employer-lead-router, _shared/ingest.ts INSERT,
--      manual replays). All converge on a stamped nonce when the
--      lead is funded.
--   4. Schema versioning: no payload contract change — the form's
--      client_nonce field stays optional from the caller's point of
--      view.
--   5. Rollback: DROP TRIGGER. Existing rows keep their nonces.
--   6. Sign-off: owner (Charlotte), 2026-05-19.

-- UP

CREATE OR REPLACE FUNCTION leads.stamp_client_nonce_if_funded()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.client_nonce IS NULL
     AND NEW.funding_category IN ('gov', 'loan') THEN
    NEW.client_nonce := gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_client_nonce_if_funded ON leads.submissions;

CREATE TRIGGER trg_stamp_client_nonce_if_funded
  BEFORE INSERT ON leads.submissions
  FOR EACH ROW
  EXECUTE FUNCTION leads.stamp_client_nonce_if_funded();

COMMENT ON TRIGGER trg_stamp_client_nonce_if_funded ON leads.submissions IS
  'Guarantees funded learner inserts (funding_category gov/loan) always have a client_nonce. Closes the gap that migration 0087 left open and that the 025 backfill panel had been mopping up. No-op when the caller already supplied a nonce.';

-- DOWN
-- DROP TRIGGER IF EXISTS trg_stamp_client_nonce_if_funded ON leads.submissions;
-- DROP FUNCTION IF EXISTS leads.stamp_client_nonce_if_funded();
