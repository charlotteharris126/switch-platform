-- Migration 0045 — auto-flip cron fires Brevo sync after flipping
-- Date: 2026-04-30
-- Author: Claude (platform session) with owner sign-off
-- Reason: Migration 0044 wired Server Actions to call crm.sync_leads_to_brevo
-- after owner-driven enrolment status changes. The third write path —
-- crm.run_enrolment_auto_flip() (the 14-day cron that flips routed open
-- rows to presumed_enrolled) — was left out and would leave Brevo's
-- SW_ENROL_STATUS stale for ~6 EMS leads on 3-4 May.
--
-- Closes the gap by collecting every flipped submission_id inside the
-- loop and firing one crm.sync_leads_to_brevo call at the end. Async,
-- best-effort, same pattern as the Server Actions.
--
-- The previous v_sample BIGINT[] capped at 10 ids and was for telemetry
-- (returned to the caller). A separate v_flipped_ids array captures the
-- full set for the Brevo sync. v_sample stays unchanged so the public
-- shape of the function (RETURNS TABLE) is preserved — no caller change
-- needed.
--
-- Related:
--   - platform/supabase/migrations/0028_enrolment_status_taxonomy_refactor.sql
--     (current function body)
--   - platform/supabase/migrations/0044_sync_leads_to_brevo.sql
--   - platform/docs/changelog.md

-- UP

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

    -- Only flip rows that are NULL or 'open'. Terminal states (enrolled, lost,
    -- cannot_reach) and the already-flipped state (presumed_enrolled) are
    -- left alone.
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

  -- Fire one Brevo sync call for every flipped lead so SW_ENROL_STATUS
  -- catches up to presumed_enrolled. Async via pg_net inside
  -- crm.sync_leads_to_brevo (migration 0044). Best-effort: pg_net or
  -- Brevo failures land in leads.dead_letter, never block the cron.
  IF coalesce(array_length(v_flipped_ids, 1), 0) > 0 THEN
    PERFORM crm.sync_leads_to_brevo(v_flipped_ids);
  END IF;

  RETURN QUERY SELECT v_flipped, v_sample;
END;
$$;

COMMENT ON FUNCTION crm.run_enrolment_auto_flip() IS
  'Cron-driven auto-flip of routed-open enrolments to presumed_enrolled after 14 days. Idempotent (skips terminal states and re-flips). Fires crm.sync_leads_to_brevo for every flipped lead so SW_ENROL_STATUS stays current in Brevo. Replaces the version from migration 0028 (which lacked the Brevo sync). Migration 0045.';

-- DOWN
-- Revert by re-running the body from 0028 without the v_flipped_ids
-- accumulator and the trailing crm.sync_leads_to_brevo PERFORM.
