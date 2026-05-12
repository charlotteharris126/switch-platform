-- Migration 0126 — extend crm.upsert_enrolment_outcome to accept employer statuses + extended lost reasons
-- Date: 2026-05-12
-- Author: Claude (Sasha) — Riverside admin outcome marking parity
-- Reason:
--   Admin uses the form at /admin/leads/[id]/enrolment-outcome-form.tsx to
--   manually mark outcomes. Calls into crm.upsert_enrolment_outcome RPC.
--   The RPC's status whitelist was learner-only (open / enrolled /
--   presumed_enrolled / cannot_reach / lost), so any attempt to set an
--   employer status (engaged / in_progress / signed / not_signed /
--   presumed_employer_signed) raised a check_violation. Admin couldn't
--   override a Riverside lead even in the rare case they needed to.
--
--   Also extends the lost_reason whitelist to include every value already
--   present in the TypeScript lead-status.ts union — the previous RPC
--   rejected `cancelled`, `withdrew_after_enrolment`,
--   `l3_mismatch_self_reported`, `cohort_decline` even though the portal
--   and bulk paths allow them.
--
--   Adds employer not_signed_reason values too (budget / wrong_levy_fit /
--   timing / competitor / decided_not_to_proceed / no_response) so admin
--   can mark not_signed with the same reason set Jane gets in the
--   EmployerOutcomeButtons component.
--
-- Impact assessment:
--   1. Change: replace function body with extended whitelists. Function
--      signature unchanged.
--   2. Readers: /admin/leads/[id]/enrolment-outcome-form + actions wrapper.
--   3. Writers: only admin via the RPC.
--   4. Rollback: replace with the original (learner-only) body. Safe iff no
--      employer-status rows have been inserted yet.
--   5. Sign-off: owner pending.

BEGIN;

CREATE OR REPLACE FUNCTION crm.upsert_enrolment_outcome(
  p_submission_id   bigint,
  p_status          text,
  p_notes           text DEFAULT NULL::text,
  p_lost_reason     text DEFAULT NULL::text,
  p_disputed        boolean DEFAULT false,
  p_disputed_reason text DEFAULT NULL::text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'crm', 'leads', 'audit', 'admin', 'public'
AS $function$
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

  -- Full status whitelist covering both lead types.
  IF p_status NOT IN (
    -- Learner
    'open', 'attempt_1_no_answer', 'attempt_2_no_answer', 'attempt_3_no_answer',
    'enrolment_meeting_booked', 'enrolled', 'presumed_enrolled',
    'cannot_reach', 'lost',
    -- Employer (Switchable for Business v1)
    'engaged', 'in_progress', 'signed', 'not_signed', 'presumed_employer_signed'
  ) THEN
    RAISE EXCEPTION 'Invalid outcome status %: not in learner or employer whitelist', p_status
      USING ERRCODE = 'check_violation';
  END IF;

  -- lost_reason required when status is the closure state for either lead type.
  -- learner closure = 'lost', employer closure = 'not_signed'.
  IF p_status IN ('lost', 'not_signed') AND (p_lost_reason IS NULL OR length(trim(p_lost_reason)) = 0) THEN
    RAISE EXCEPTION 'A reason is required when closing a lead (status=% requires lost_reason)', p_status
      USING ERRCODE = 'not_null_violation';
  END IF;

  -- Extended lost_reason whitelist — combines learner + employer values.
  -- The same column stores both; lead_type on the submission disambiguates.
  IF p_lost_reason IS NOT NULL
     AND p_lost_reason NOT IN (
       -- Learner reasons (matches VALID_LOST_REASONS in lib/lead-status.ts)
       'not_interested', 'wrong_course', 'funding_issue', 'cancelled',
       'withdrew_after_enrolment', 'l3_mismatch_self_reported',
       'cohort_decline', 'other',
       -- Employer reasons (matches VALID_NOT_SIGNED_REASONS)
       'budget', 'wrong_levy_fit', 'timing', 'competitor',
       'decided_not_to_proceed', 'no_response'
     ) THEN
    RAISE EXCEPTION 'Invalid lost_reason %: not in learner or employer whitelist', p_lost_reason
      USING ERRCODE = 'check_violation';
  END IF;

  -- Disputes apply only to presumed states (both lead types).
  IF p_disputed AND p_status NOT IN ('presumed_enrolled', 'presumed_employer_signed') THEN
    RAISE EXCEPTION 'Disputes can only be raised against presumed states (got status=%)', p_status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id, provider_id, routed_at
    INTO v_routing_log_id, v_provider_id, v_routed_at
    FROM leads.routing_log
   WHERE submission_id = p_submission_id
   ORDER BY routed_at DESC
   LIMIT 1;

  IF v_provider_id IS NULL THEN
    RAISE EXCEPTION 'Submission % has no routing_log entry.', p_submission_id
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT * INTO v_existing
    FROM crm.enrolments
   WHERE submission_id = p_submission_id AND provider_id = v_provider_id
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
    CASE WHEN p_status IN ('lost', 'not_signed') THEN p_lost_reason ELSE NULL END,
    v_disputed_at,
    CASE WHEN p_disputed THEN p_disputed_reason ELSE NULL END
  )
  ON CONFLICT (submission_id, provider_id) DO UPDATE SET
    status            = EXCLUDED.status,
    status_updated_at = now(),
    notes             = EXCLUDED.notes,
    lost_reason       = EXCLUDED.lost_reason,
    disputed_at       = EXCLUDED.disputed_at,
    disputed_reason   = CASE WHEN p_disputed THEN EXCLUDED.disputed_reason ELSE crm.enrolments.disputed_reason END,
    updated_at        = now()
  RETURNING id INTO v_enrolment_id;

  v_before := CASE WHEN v_existing.id IS NOT NULL THEN jsonb_build_object(
    'status',          v_existing.status,
    'notes',           v_existing.notes,
    'lost_reason',     v_existing.lost_reason,
    'disputed_at',     v_existing.disputed_at,
    'disputed_reason', v_existing.disputed_reason
  ) ELSE NULL END;

  v_after := jsonb_build_object(
    'status',          p_status,
    'notes',           p_notes,
    'lost_reason',     CASE WHEN p_status IN ('lost', 'not_signed') THEN p_lost_reason ELSE NULL END,
    'disputed_at',     v_disputed_at,
    'disputed_reason', CASE WHEN p_disputed THEN p_disputed_reason ELSE NULL END
  );

  PERFORM audit.log_action(
    p_action       := 'mark_enrolment_outcome',
    p_target_table := 'crm.enrolments',
    p_target_id    := v_enrolment_id::text,
    p_before       := v_before,
    p_after        := v_after,
    p_context      := jsonb_build_object('submission_id', p_submission_id, 'provider_id', v_provider_id),
    p_surface      := 'admin'
  );

  -- Referral programme — learner enrolment only. Employer 'signed' has
  -- no referral semantics in v1.
  IF p_status = 'enrolled' THEN
    PERFORM leads.flip_referral_eligible(p_submission_id);
  END IF;

  RETURN v_enrolment_id;
END;
$function$;

COMMIT;
