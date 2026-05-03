-- Migration 0055 — fix referral eligible-flip hook on the live 6-arg upsert
-- Date: 2026-05-03
-- Author: Claude (Sasha session) with owner review
-- Reason: Migration 0054 wrote the leads.flip_referral_eligible hook into a
--   3-arg crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT) signature copied
--   from migration 0022. Migration 0028 had already replaced that signature
--   with a 6-arg version (BIGINT, TEXT, TEXT, TEXT, BOOLEAN, TEXT). Postgres
--   treated 0054's body as a separate overload, so the 6-arg version (the one
--   actually called by app/admin/leads/[id]/actions.ts and bulk-actions.ts)
--   never received the hook. The cron path
--   (crm.run_enrolment_auto_flip) was patched correctly and is unaffected.
--   This migration:
--     1. Drops the dead 3-arg overload that 0054 created.
--     2. CREATE OR REPLACE the 6-arg signature with the hook inserted after
--        the audit log call, before RETURN.
-- Related: platform/supabase/migrations/0028_enrolment_status_taxonomy_refactor.sql
--          platform/supabase/migrations/0053_add_referral_programme.sql
--          platform/supabase/migrations/0054_referral_eligible_hooks.sql
--          platform/docs/data-architecture.md (leads.referrals section)
--          ClickUp 869d4ud8t (referral programme parent)
--
-- =============================================================================
-- UP
-- =============================================================================

BEGIN;

-- 1. Drop the dead 3-arg overload that 0054 created. Nothing in the codebase
--    calls it; it exists only because 0054's CREATE OR REPLACE landed with
--    the wrong argument list.
DROP FUNCTION IF EXISTS crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT);

-- 2. Replace the live 6-arg crm.upsert_enrolment_outcome with a body that
--    fires leads.flip_referral_eligible when the friend has enrolled
--    (manually marked OR promoted to presumed_enrolled). Body is identical
--    to migration 0028 plus the new PERFORM block at the end (after the
--    audit log, before RETURN). All other validation, upsert, and audit
--    behaviour is preserved verbatim.
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
  -- Caller must be admin
  IF NOT admin.is_admin() THEN
    RAISE EXCEPTION 'Only admins can mark enrolment outcomes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Validate status against the canonical set.
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

  -- Referral programme hook (migration 0054, fixed in 0055). When the friend
  -- has enrolled (manually confirmed via the admin UI OR promoted to
  -- presumed_enrolled by the cron path), flip any pending referral row to
  -- 'eligible'. Idempotent; leads.flip_referral_eligible is a no-op if
  -- there's no matching referral or it's already past pending state.
  IF p_status IN ('enrolled', 'presumed_enrolled') THEN
    PERFORM leads.flip_referral_eligible(p_submission_id);
  END IF;

  RETURN v_enrolment_id;
END;
$$;

COMMENT ON FUNCTION crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT, TEXT, BOOLEAN, TEXT) IS
  'Sets the enrolment outcome for a routed lead under the canonical taxonomy (open/enrolled/presumed_enrolled/cannot_reach/lost). Validates lost_reason on lost rows; persists disputes as flags on presumed_enrolled. Fires leads.flip_referral_eligible when status is enrolled or presumed_enrolled, all in one transaction. The only sanctioned write path. Body added migration 0028, referral hook added migration 0055 (corrects 0054 which targeted the wrong overload).';

REVOKE ALL ON FUNCTION crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT, TEXT, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT, TEXT, BOOLEAN, TEXT) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
--
-- 1. Restore the 6-arg upsert body without the referral hook by re-running
--    the CREATE OR REPLACE block from migration 0028 (lines 104-257). Strip
--    the new PERFORM block (the 'IF p_status IN (...) THEN PERFORM
--    leads.flip_referral_eligible(...); END IF;' chunk above the RETURN).
--    Refresh the comment to the migration 0028 wording.
--
-- 2. Re-introduce the dead 3-arg overload that 0054 created if true
--    state-restoration is required. In practice, leaving it dropped is
--    cleaner — nothing called it. Block:
--
--    CREATE OR REPLACE FUNCTION crm.upsert_enrolment_outcome(
--      p_submission_id BIGINT, p_status TEXT, p_notes TEXT DEFAULT NULL
--    ) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER ...
--    (Full body in migration 0054 lines 38-129.)
--
-- COMMIT;
