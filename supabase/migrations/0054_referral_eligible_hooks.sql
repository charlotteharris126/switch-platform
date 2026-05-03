-- Migration 0054 — wire crm enrolment-confirmation paths into leads.flip_referral_eligible
-- Date: 2026-05-02
-- Author: Claude (Sasha session) with owner review
-- Reason: Migration 0053 created leads.flip_referral_eligible(submission_id), which
--   flips a pending referral row to 'eligible' (and sets needs_manual_review when the
--   soft cap is hit). Two crm functions need to call it on every status transition
--   that means "the referred friend has now enrolled":
--
--     1. crm.upsert_enrolment_outcome(...) — owner-driven path. Called from the
--        admin dashboard when Charlotte marks an outcome. Triggers the flip when the
--        new status is 'enrolled' OR 'presumed_enrolled' (covers manual confirmation
--        and the dashboard "Presumed enrolled" button).
--
--     2. crm.run_enrolment_auto_flip() — cron-driven path. Already accumulates
--        v_flipped_ids for the Brevo sync (per migration 0045); we add a parallel
--        PERFORM that calls the referral flip helper for every flipped submission.
--
--   The helper is idempotent: calling it on a submission with no pending referral
--   row is a no-op (returns false). Safe to call unconditionally on every flip.
--
-- Related:
--   - platform/supabase/migrations/0053_add_referral_programme.sql (defines the helper)
--   - platform/supabase/migrations/0022_enrolment_outcome_helper.sql (original upsert body)
--   - platform/supabase/migrations/0045_auto_flip_calls_brevo_sync.sql (current auto-flip body)
--   - strategy/docs/referral-programme-scope.md
--   - ClickUp 869d4ud8t

-- =============================================================================
-- UP
-- =============================================================================

BEGIN;

-- 1. Replace crm.upsert_enrolment_outcome with a body that fires
--    leads.flip_referral_eligible when the new status indicates the friend has
--    enrolled. Body is identical to migration 0022 plus the new PERFORM at the
--    end (after the audit log, before RETURN).
CREATE OR REPLACE FUNCTION crm.upsert_enrolment_outcome(
  p_submission_id BIGINT,
  p_status        TEXT,
  p_notes         TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm, leads, audit, admin, public
AS $$
DECLARE
  v_enrolment_id   BIGINT;
  v_provider_id    TEXT;
  v_routed_at      TIMESTAMPTZ;
  v_routing_log_id BIGINT;
  v_existing       crm.enrolments%ROWTYPE;
  v_before         JSONB;
  v_after          JSONB;
BEGIN
  IF NOT admin.is_admin() THEN
    RAISE EXCEPTION 'Only admins can mark enrolment outcomes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_status NOT IN ('enrolled', 'not_enrolled', 'presumed_enrolled', 'disputed') THEN
    RAISE EXCEPTION 'Invalid outcome status %: must be one of enrolled, not_enrolled, presumed_enrolled, disputed', p_status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT id, provider_id, routed_at
    INTO v_routing_log_id, v_provider_id, v_routed_at
    FROM leads.routing_log
   WHERE submission_id = p_submission_id
   ORDER BY routed_at DESC
   LIMIT 1;

  IF v_provider_id IS NULL THEN
    RAISE EXCEPTION 'Submission % has no routing_log entry. Route the lead before marking an enrolment outcome.', p_submission_id
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT *
    INTO v_existing
    FROM crm.enrolments
   WHERE submission_id = p_submission_id
     AND provider_id   = v_provider_id
   LIMIT 1;

  INSERT INTO crm.enrolments (
    submission_id, routing_log_id, provider_id, status,
    sent_to_provider_at, status_updated_at, notes
  ) VALUES (
    p_submission_id, v_routing_log_id, v_provider_id, p_status,
    v_routed_at, now(), p_notes
  )
  ON CONFLICT (submission_id, provider_id) DO UPDATE SET
    status            = EXCLUDED.status,
    status_updated_at = now(),
    notes             = EXCLUDED.notes,
    updated_at        = now()
  RETURNING id INTO v_enrolment_id;

  v_before := CASE
    WHEN v_existing.id IS NOT NULL
      THEN jsonb_build_object('status', v_existing.status, 'notes', v_existing.notes)
    ELSE NULL
  END;
  v_after := jsonb_build_object('status', p_status, 'notes', p_notes);

  PERFORM audit.log_action(
    p_action       := 'mark_enrolment_outcome',
    p_target_table := 'crm.enrolments',
    p_target_id    := v_enrolment_id::text,
    p_before       := v_before,
    p_after        := v_after,
    p_context      := jsonb_build_object(
      'submission_id', p_submission_id,
      'provider_id',   v_provider_id
    ),
    p_surface      := 'admin'
  );

  -- Referral programme hook (migration 0054). When the friend has enrolled
  -- (manually confirmed OR presumed-enrolled by the dashboard button), flip
  -- any pending referral row to 'eligible'. Idempotent.
  IF p_status IN ('enrolled', 'presumed_enrolled') THEN
    PERFORM leads.flip_referral_eligible(p_submission_id);
  END IF;

  RETURN v_enrolment_id;
END;
$$;

COMMENT ON FUNCTION crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT) IS
  'Sets the enrolment outcome for a routed lead. Atomic: validates status, gates on admin.is_admin(), looks up routing context, upserts crm.enrolments, writes audit row, fires leads.flip_referral_eligible when the new status is enrolled or presumed_enrolled — all in one transaction. The only sanctioned write path. Body refreshed by migration 0054 (referral hook added).';

-- 2. Replace crm.run_enrolment_auto_flip with a body that fires
--    leads.flip_referral_eligible for every flipped submission_id, alongside
--    the existing crm.sync_leads_to_brevo bulk call.
CREATE OR REPLACE FUNCTION crm.run_enrolment_auto_flip()
RETURNS TABLE(flipped_count INTEGER, sample_submission_ids BIGINT[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm, leads, audit, public
AS $$
DECLARE
  r                    RECORD;
  v_flipped            INTEGER := 0;
  v_sample             BIGINT[] := ARRAY[]::BIGINT[];
  v_flipped_ids        BIGINT[] := ARRAY[]::BIGINT[];
  v_dispute_deadline   TIMESTAMPTZ := now() + INTERVAL '7 days';
  v_existing           crm.enrolments%ROWTYPE;
  v_enrolment_id       BIGINT;
  v_flipped_id         BIGINT;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (rl.submission_id)
      rl.id          AS routing_log_id,
      rl.submission_id,
      rl.provider_id,
      rl.routed_at
      FROM leads.routing_log rl
      JOIN leads.submissions s ON s.id = rl.submission_id
     WHERE rl.routed_at < now() - INTERVAL '14 days'
       AND s.is_dq = false
       AND s.archived_at IS NULL
     ORDER BY rl.submission_id, rl.routed_at DESC
  LOOP
    SELECT *
      INTO v_existing
      FROM crm.enrolments
     WHERE submission_id = r.submission_id
       AND provider_id   = r.provider_id
     LIMIT 1;

    IF v_existing.id IS NOT NULL
       AND v_existing.status <> 'open' THEN
      CONTINUE;
    END IF;

    INSERT INTO crm.enrolments (
      submission_id, routing_log_id, provider_id, status,
      sent_to_provider_at, status_updated_at,
      presumed_deadline_at, dispute_deadline_at
    ) VALUES (
      r.submission_id, r.routing_log_id, r.provider_id, 'presumed_enrolled',
      r.routed_at, now(),
      now(), v_dispute_deadline
    )
    ON CONFLICT (submission_id, provider_id) DO UPDATE SET
      status               = 'presumed_enrolled',
      status_updated_at    = now(),
      presumed_deadline_at = now(),
      dispute_deadline_at  = v_dispute_deadline,
      updated_at           = now()
    RETURNING id INTO v_enrolment_id;

    PERFORM audit.log_system_action(
      p_actor        := 'system:cron:enrolment-auto-flip',
      p_action       := 'auto_flip_to_presumed_enrolled',
      p_target_table := 'crm.enrolments',
      p_target_id    := v_enrolment_id::text,
      p_before       := CASE
        WHEN v_existing.id IS NOT NULL
          THEN jsonb_build_object('status', v_existing.status)
        ELSE NULL
      END,
      p_after        := jsonb_build_object(
        'status', 'presumed_enrolled',
        'dispute_deadline_at', v_dispute_deadline
      ),
      p_context      := jsonb_build_object(
        'submission_id',     r.submission_id,
        'provider_id',       r.provider_id,
        'routed_at',         r.routed_at,
        'days_since_routed', EXTRACT(DAY FROM now() - r.routed_at)::INT
      )
    );

    v_flipped := v_flipped + 1;
    v_flipped_ids := array_append(v_flipped_ids, r.submission_id);
    IF coalesce(array_length(v_sample, 1), 0) < 10 THEN
      v_sample := array_append(v_sample, r.submission_id);
    END IF;
  END LOOP;

  IF coalesce(array_length(v_flipped_ids, 1), 0) > 0 THEN
    -- Brevo sync (per migration 0045) — keeps SW_ENROL_STATUS current.
    PERFORM crm.sync_leads_to_brevo(v_flipped_ids);

    -- Referral programme hook (migration 0054). Idempotent: the helper is a
    -- no-op when there is no pending referral for the submission.
    FOREACH v_flipped_id IN ARRAY v_flipped_ids LOOP
      PERFORM leads.flip_referral_eligible(v_flipped_id);
    END LOOP;
  END IF;

  RETURN QUERY SELECT v_flipped, v_sample;
END;
$$;

COMMENT ON FUNCTION crm.run_enrolment_auto_flip() IS
  'Cron-driven auto-flip of routed-open enrolments to presumed_enrolled after 14 days. Idempotent (skips terminal states and re-flips). Fires crm.sync_leads_to_brevo for every flipped lead so SW_ENROL_STATUS stays current in Brevo. Fires leads.flip_referral_eligible for every flipped lead so any pending referral becomes eligible for voucher payout. Body refreshed by migration 0054.';

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- Restore the bodies from migration 0022 (upsert_enrolment_outcome) and
-- migration 0045 (run_enrolment_auto_flip) without the leads.flip_referral_eligible
-- PERFORM calls. Both functions remain CREATE OR REPLACE, so reverting is the
-- inverse: paste in the prior bodies.
-- COMMIT;
