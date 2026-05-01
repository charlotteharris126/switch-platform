-- Migration 0048 — crm.resolve_pending_update RPC for dashboard approve/reject/override
-- Date: 2026-05-01
-- Author: Claude (platform session) with owner sign-off
-- Reason: The dashboard's `authenticated` role has SELECT-only on crm
-- tables — same as every other crm consumer that doesn't go through an
-- Edge Function. The /admin/sheet-activity page needs to apply AI
-- suggestion resolutions (approve / reject / choose different) when the
-- owner clicks the inline buttons. Following the fire_provider_chaser
-- pattern (migration 0046), the resolution logic lives in a SECURITY
-- DEFINER RPC that authenticated can EXECUTE. This keeps writes off the
-- direct table grants and the resolution flow atomic.
--
-- What the RPC does:
--   1. Validates p_action is one of approve/reject/override (and override
--      requires a valid p_override_status from the enrolment status enum).
--   2. Reads the pending_updates row; bails if not 'pending' (idempotent).
--   3. Reject: marks pending_updates rejected, no enrolment change.
--   4. Approve / Override:
--      - Reads current enrolments status; bails if billed/paid (anomaly).
--      - Updates enrolments.status if it differs from chosen.
--      - Inserts crm.disputes row if chosen status = 'disputed'.
--      - Marks pending_updates approved/overridden with applied_at.
--   5. Always inserts a resolution row in sheet_edits_log carrying the
--      original provider_id / submission_id from the AI suggestion's
--      source row.
--
-- Mirrors the email-link path in pending-update-confirm (Edge Function)
-- which uses HMAC tokens. The RPC route is for the dashboard where the
-- user is already authenticated.

-- UP

CREATE OR REPLACE FUNCTION crm.resolve_pending_update(
  p_id BIGINT,
  p_action TEXT,
  p_override_status TEXT DEFAULT NULL
) RETURNS TABLE(ok BOOLEAN, message TEXT, applied_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm, public
AS $$
DECLARE
  v_pending     crm.pending_updates%ROWTYPE;
  v_current     TEXT;
  v_new_status  TEXT;
  v_resolution  TEXT;
  v_audit_action TEXT;
  v_orig        RECORD;
  v_valid_overrides TEXT[] := ARRAY['contacted','enrolled','presumed_enrolled','cannot_reach','lost','not_enrolled','disputed'];
BEGIN
  IF p_action NOT IN ('approve','reject','override') THEN
    RETURN QUERY SELECT false, 'invalid action'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_pending FROM crm.pending_updates WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not found'::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  IF v_pending.status <> 'pending' THEN
    RETURN QUERY SELECT false, ('already ' || v_pending.status)::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF p_action = 'reject' THEN
    UPDATE crm.pending_updates
       SET status = 'rejected', resolved_at = now(), resolved_by = 'owner'
     WHERE id = p_id;
    v_audit_action := 'ai_rejected';
    v_new_status := NULL;
  ELSE
    IF p_action = 'override' THEN
      IF p_override_status IS NULL OR NOT (p_override_status = ANY(v_valid_overrides)) THEN
        RETURN QUERY SELECT false, 'invalid override status'::TEXT, NULL::TEXT;
        RETURN;
      END IF;
      v_new_status := p_override_status;
      v_resolution := 'overridden';
      v_audit_action := 'ai_overridden';
    ELSE
      v_new_status := v_pending.suggested_status;
      v_resolution := 'approved';
      v_audit_action := 'ai_approved';
    END IF;

    SELECT status INTO v_current FROM crm.enrolments WHERE id = v_pending.enrolment_id;
    IF NOT FOUND THEN
      RETURN QUERY SELECT false, 'enrolment not found'::TEXT, NULL::TEXT;
      RETURN;
    END IF;
    IF v_current IN ('billed','paid') THEN
      RETURN QUERY SELECT false, ('already ' || v_current)::TEXT, NULL::TEXT;
      RETURN;
    END IF;

    IF v_current <> v_new_status THEN
      UPDATE crm.enrolments
         SET status = v_new_status, status_updated_at = now(), updated_at = now()
       WHERE id = v_pending.enrolment_id;
      IF v_new_status = 'disputed' THEN
        INSERT INTO crm.disputes (enrolment_id, raised_by, reason)
        VALUES (v_pending.enrolment_id, 'owner',
                'AI ' || v_resolution || ' via dashboard: ' || coalesce(v_pending.ai_summary, 'no summary'));
      END IF;
    END IF;

    UPDATE crm.pending_updates
       SET status = v_resolution,
           override_status = CASE WHEN p_action = 'override' THEN v_new_status ELSE NULL END,
           resolved_at = now(),
           resolved_by = 'owner',
           applied_at = now()
     WHERE id = p_id;
  END IF;

  -- Audit row in sheet_edits_log carrying provider/submission context
  SELECT provider_id, submission_id, column_name INTO v_orig
    FROM crm.sheet_edits_log WHERE pending_update_id = p_id ORDER BY id ASC LIMIT 1;
  IF FOUND THEN
    INSERT INTO crm.sheet_edits_log (
      enrolment_id, submission_id, provider_id, column_name,
      old_value, new_value, editor_email, edited_at,
      action, applied_status, pending_update_id, reason
    ) VALUES (
      v_pending.enrolment_id, v_orig.submission_id, v_orig.provider_id, v_orig.column_name,
      v_pending.current_status, v_new_status, 'owner@dashboard', now(),
      v_audit_action, v_new_status, p_id, 'Resolved by owner via dashboard'
    );
  END IF;

  RETURN QUERY SELECT true,
    CASE p_action
      WHEN 'reject' THEN 'Rejected'
      WHEN 'approve' THEN 'Approved'
      ELSE ('Set to ' || v_new_status)
    END::TEXT,
    v_new_status;
END;
$$;

GRANT EXECUTE ON FUNCTION crm.resolve_pending_update(BIGINT, TEXT, TEXT) TO authenticated;

-- DOWN
-- REVOKE EXECUTE ON FUNCTION crm.resolve_pending_update(BIGINT, TEXT, TEXT) FROM authenticated;
-- DROP FUNCTION crm.resolve_pending_update(BIGINT, TEXT, TEXT);
