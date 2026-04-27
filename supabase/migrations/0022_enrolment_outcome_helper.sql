-- Migration 0022 — Enrolment outcome write surface (Session D)
-- Date: 2026-04-25
-- Author: Claude (platform Session D) with owner sign-off
-- Reason: Charlotte needs to record per-lead enrolment outcomes from the
--         admin dashboard ahead of Tuesday 28 Apr 13:00 EMS catch-up call.
--         Today there's nowhere clean to write the outcome — leads land in
--         Andy's sheet, decisions stay verbal. Without persisted outcomes
--         the dashboard can't show Routed-vs-Enrolled, billing eligibility,
--         or any lifecycle counts.
--
--         This migration ships three pieces:
--
--         1. UNIQUE INDEX on (submission_id, provider_id) — needed for the
--            ON CONFLICT upsert below. Safe to add: no rows in
--            crm.enrolments yet (verified before applying).
--
--         2. CHECK constraint on status — enforces the canonical set:
--            open | contacted | enrolled | not_enrolled |
--            presumed_enrolled | disputed. The first three were already
--            implied by partial indexes; this makes the contract explicit.
--
--         3. crm.upsert_enrolment_outcome(submission_id, status, notes)
--            SECURITY DEFINER function. The only sanctioned write path for
--            outcome marking. Validates input, gates on admin.is_admin(),
--            looks up routing_log for provider_id + sent_to_provider_at,
--            upserts the row, and writes an audit row in the same
--            transaction (atomic).
--
-- Related: platform/supabase/migrations/0020_audit_log_action_helper.sql,
--          platform/docs/admin-dashboard-scoping.md § Session D.

-- UP

-- =============================================================================
-- 1. UNIQUE INDEX (submission_id, provider_id)
-- =============================================================================
-- One outcome row per (lead, provider) — even if a lead were re-routed to the
-- same provider, the outcome state is the latest decision, not a per-event
-- history. The audit table holds the full change log.

CREATE UNIQUE INDEX IF NOT EXISTS enrolments_submission_provider_uniq_idx
  ON crm.enrolments (submission_id, provider_id);

-- =============================================================================
-- 2. CHECK constraint on status
-- =============================================================================

ALTER TABLE crm.enrolments DROP CONSTRAINT IF EXISTS enrolments_status_chk;
ALTER TABLE crm.enrolments
  ADD CONSTRAINT enrolments_status_chk
  CHECK (status IN ('open', 'contacted', 'enrolled', 'not_enrolled', 'presumed_enrolled', 'disputed'));

-- =============================================================================
-- 3. crm.upsert_enrolment_outcome(...)
-- =============================================================================

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
  -- Caller must be admin (admin.is_admin() reads auth.jwt()->>'email')
  IF NOT admin.is_admin() THEN
    RAISE EXCEPTION 'Only admins can mark enrolment outcomes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Validate against the canonical set. The CHECK constraint above also
  -- enforces this, but failing here gives a clearer error to the Server
  -- Action layer instead of the table-level constraint message.
  IF p_status NOT IN ('enrolled', 'not_enrolled', 'presumed_enrolled', 'disputed') THEN
    RAISE EXCEPTION 'Invalid outcome status %: must be one of enrolled, not_enrolled, presumed_enrolled, disputed', p_status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Find the routing context. Most recent routing_log row for this
  -- submission wins (handles edge cases like a lead re-routed to the same
  -- provider after a manual reset — vanishingly rare today, but stable).
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

  -- Capture existing row for audit "before" state
  SELECT *
    INTO v_existing
    FROM crm.enrolments
   WHERE submission_id = p_submission_id
     AND provider_id   = v_provider_id
   LIMIT 1;

  -- UPSERT
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

  -- Audit
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

  RETURN v_enrolment_id;
END;
$$;

COMMENT ON FUNCTION crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT) IS
  'Sets the enrolment outcome for a routed lead. Atomic: validates status, gates on admin.is_admin(), looks up routing context, upserts crm.enrolments, writes audit row — all in one transaction. The only sanctioned write path. Added migration 0022.';

REVOKE ALL ON FUNCTION crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT) TO authenticated;

-- DOWN
-- REVOKE EXECUTE ON FUNCTION crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT) FROM authenticated;
-- DROP FUNCTION IF EXISTS crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT);
-- ALTER TABLE crm.enrolments DROP CONSTRAINT IF EXISTS enrolments_status_chk;
-- DROP INDEX IF EXISTS crm.enrolments_submission_provider_uniq_idx;
