-- Migration 0067 — restrict referral eligible-flip to confirmed enrolment only
-- Date: 2026-05-04
-- Author: Claude (Sasha session) with owner review
-- Reason: Charlotte decided the voucher should fire on provider-confirmed
--   enrolment only. Presumed-enrolment (14-day auto-flip) no longer triggers
--   the eligible flip. Rationale: vouchers should not fire before a provider
--   has confirmed the friend actually started. Presumed rows are billing
--   placeholders; a referrer voucher on a presumed row that later gets
--   disputed would mean paying out for an enrolment that didn't happen.
--
--   Two write paths previously fired on both statuses:
--
--     1. crm.upsert_enrolment_outcome — admin dashboard, manual confirm.
--        Changed: IF p_status IN ('enrolled', 'presumed_enrolled') →
--                 IF p_status = 'enrolled'
--        The v_flipped_id variable declaration and the comment above the hook
--        are updated to match.
--
--     2. crm.run_enrolment_auto_flip — cron-driven 14-day auto-flip.
--        Changed: FOREACH loop calling flip_referral_eligible removed entirely.
--        The v_flipped_id BIGINT declaration (only used by that loop) is also
--        removed. The Brevo sync loop (sync_leads_to_brevo) is unaffected.
--
--   The admin dashboard /admin/referrals shows rows at voucher_status='eligible'.
--   No dashboard change is needed — the eligible flip gate in the DB is the
--   sole control. Any referral that was already flipped to eligible via a
--   presumed_enrolled trigger before this migration will remain at eligible
--   (idempotent; there are zero such rows in production as of 2026-05-04
--   since leads.referrals was empty at last check).
--
-- Related:
--   - platform/supabase/migrations/0053_add_referral_programme.sql (data model)
--   - platform/supabase/migrations/0054_referral_eligible_hooks.sql (original hook)
--   - platform/supabase/migrations/0055_referral_hook_fix_6arg.sql (6-arg fix)
--   - strategy/docs/referral-programme-scope.md (scope doc — trigger line
--     updated separately by Mira)

-- =============================================================================
-- UP
-- =============================================================================

BEGIN;

-- 1. crm.upsert_enrolment_outcome — fire referral flip on 'enrolled' only.
--    Full body from migration 0055; only the referral hook IF condition and
--    its comment change.
CREATE OR REPLACE FUNCTION crm.upsert_enrolment_outcome(
  p_submission_id    BIGINT,
  p_status           TEXT,
  p_notes            TEXT DEFAULT NULL,
  p_lost_reason      TEXT DEFAULT NULL,
  p_disputed         BOOLEAN DEFAULT FALSE,
  p_disputed_reason  TEXT DEFAULT NULL
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
  v_disputed_at    TIMESTAMPTZ;
BEGIN
  IF NOT admin.is_admin() THEN
    RAISE EXCEPTION 'Only admins can mark enrolment outcomes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_status NOT IN ('open', 'enrolled', 'presumed_enrolled', 'cannot_reach', 'lost') THEN
    RAISE EXCEPTION 'Invalid outcome status %: must be one of open, enrolled, presumed_enrolled, cannot_reach, lost', p_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_status = 'lost' AND (p_lost_reason IS NULL OR length(trim(p_lost_reason)) = 0) THEN
    RAISE EXCEPTION 'lost_reason is required when status=''lost'' (one of: not_interested, wrong_course, funding_issue, other)'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_lost_reason IS NOT NULL
     AND p_lost_reason NOT IN ('not_interested', 'wrong_course', 'funding_issue', 'other') THEN
    RAISE EXCEPTION 'Invalid lost_reason %: must be one of not_interested, wrong_course, funding_issue, other', p_lost_reason
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_disputed AND p_status <> 'presumed_enrolled' THEN
    RAISE EXCEPTION 'Disputes can only be raised against presumed_enrolled rows (got status=%)', p_status
      USING ERRCODE = 'invalid_parameter_value';
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

  v_disputed_at := CASE
    WHEN p_disputed AND v_existing.disputed_at IS NULL THEN now()
    WHEN p_disputed THEN v_existing.disputed_at
    ELSE v_existing.disputed_at
  END;

  INSERT INTO crm.enrolments (
    submission_id, routing_log_id, provider_id, status,
    sent_to_provider_at, status_updated_at, notes,
    lost_reason, disputed_at, disputed_reason
  ) VALUES (
    p_submission_id, v_routing_log_id, v_provider_id, p_status,
    v_routed_at, now(), p_notes,
    CASE WHEN p_status = 'lost' THEN p_lost_reason ELSE NULL END,
    v_disputed_at,
    CASE WHEN p_disputed THEN p_disputed_reason ELSE NULL END
  )
  ON CONFLICT (submission_id, provider_id) DO UPDATE SET
    status            = EXCLUDED.status,
    status_updated_at = now(),
    notes             = EXCLUDED.notes,
    lost_reason       = EXCLUDED.lost_reason,
    disputed_at       = EXCLUDED.disputed_at,
    disputed_reason   = CASE
      WHEN p_disputed THEN EXCLUDED.disputed_reason
      ELSE crm.enrolments.disputed_reason
    END,
    updated_at        = now()
  RETURNING id INTO v_enrolment_id;

  v_before := CASE
    WHEN v_existing.id IS NOT NULL THEN jsonb_build_object(
      'status',          v_existing.status,
      'notes',           v_existing.notes,
      'lost_reason',     v_existing.lost_reason,
      'disputed_at',     v_existing.disputed_at,
      'disputed_reason', v_existing.disputed_reason
    )
    ELSE NULL
  END;
  v_after := jsonb_build_object(
    'status',          p_status,
    'notes',           p_notes,
    'lost_reason',     CASE WHEN p_status = 'lost' THEN p_lost_reason ELSE NULL END,
    'disputed_at',     v_disputed_at,
    'disputed_reason', CASE WHEN p_disputed THEN p_disputed_reason ELSE NULL END
  );

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

  -- Referral programme hook (migration 0067). Fires only on provider-confirmed
  -- enrolment. Presumed-enrolment no longer triggers the voucher — voucher
  -- should not fire until a provider has confirmed the friend actually started.
  IF p_status = 'enrolled' THEN
    PERFORM leads.flip_referral_eligible(p_submission_id);
  END IF;

  RETURN v_enrolment_id;
END;
$$;

COMMENT ON FUNCTION crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT, TEXT, BOOLEAN, TEXT) IS
  'Sets the enrolment outcome for a routed lead under the canonical taxonomy (open/enrolled/presumed_enrolled/cannot_reach/lost). Validates lost_reason on lost rows; persists disputes as flags on presumed_enrolled. Fires leads.flip_referral_eligible only when status=enrolled (provider-confirmed); presumed_enrolled no longer triggers the referral voucher. Body added migration 0028, referral hook added 0055, restricted to enrolled-only in 0067.';

REVOKE ALL ON FUNCTION crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT, TEXT, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT, TEXT, BOOLEAN, TEXT) TO authenticated;


-- 2. crm.run_enrolment_auto_flip — remove referral flip loop entirely.
--    Full body from migration 0054; v_flipped_id declaration and the
--    FOREACH referral loop are removed. Brevo sync is unaffected.
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
    PERFORM crm.sync_leads_to_brevo(v_flipped_ids);
    -- Referral flip removed in migration 0067: voucher fires on
    -- provider-confirmed enrolment only, not on presumed_enrolled.
  END IF;

  RETURN QUERY SELECT v_flipped, v_sample;
END;
$$;

COMMENT ON FUNCTION crm.run_enrolment_auto_flip() IS
  'Cron-driven auto-flip of routed-open enrolments to presumed_enrolled after 14 days. Idempotent (skips terminal states). Fires crm.sync_leads_to_brevo so SW_ENROL_STATUS stays current in Brevo. Does NOT fire leads.flip_referral_eligible — referral vouchers require provider-confirmed enrolment (migration 0067). Body from migration 0054, updated 0067.';

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- Restore both functions to fire flip_referral_eligible on presumed_enrolled too.
--
-- 1. upsert_enrolment_outcome: change
--      IF p_status = 'enrolled' THEN
--    back to:
--      IF p_status IN ('enrolled', 'presumed_enrolled') THEN
--    and restore the comment wording from migration 0055.
--
-- 2. run_enrolment_auto_flip: re-add
--      v_flipped_id BIGINT;
--    to the DECLARE block and restore the FOREACH loop after the Brevo sync:
--      FOREACH v_flipped_id IN ARRAY v_flipped_ids LOOP
--        PERFORM leads.flip_referral_eligible(v_flipped_id);
--      END LOOP;
-- COMMIT;