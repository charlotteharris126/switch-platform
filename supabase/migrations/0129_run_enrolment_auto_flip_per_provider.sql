-- Migration 0129 — rewrite crm.run_enrolment_auto_flip for per-provider SLAs + employer leads
-- Date: 2026-05-12
-- Author: Claude (Sasha)
-- Reason:
--   Original function (re-scheduled by migration 0097, never applied as a
--   live cron at that scheduling) hardcoded 14 days for everyone and
--   always flipped to presumed_enrolled. With migration 0127 (per-provider
--   sla_presumed_flip_days) + 0122 (lead_type) + 0128 (auto_flip_enabled +
--   sla_accepted_at), the function needs three changes:
--
--     1. Days threshold per provider:
--        - PPA v1 (EMS / CD / WYK): 14 days (unchanged)
--        - PPA v2 (Riverside): 60 days
--        Sourced from crm.providers.sla_presumed_flip_days.
--
--     2. Target status per lead_type:
--        - learner → presumed_enrolled
--        - employer_apprenticeship → presumed_employer_signed
--        Sourced from leads.submissions.lead_type.
--
--     3. Activity gate:
--        Skip any lead whose provider has either
--        auto_flip_enabled = false  OR  sla_accepted_at IS NULL.
--        Both conditions must be true for the flip to fire.
--        Implementation: provider rows joined into the FOR loop and
--        filtered. Eliminates the original 'leads only on day 14' rule
--        in favour of a per-provider threshold.
--
--   The dispute_deadline_at (+7 days from flip) and audit log entry are
--   unchanged shape — they get the new context fields (lead_type,
--   provider_threshold_days) for traceability.
--
-- Impact assessment:
--   1. Change: replace function body; signature unchanged. Function still
--      returns (flipped_count, sample_submission_ids).
--   2. Readers: cron job 'enrolment-auto-flip-daily' (scheduled by 0097
--      once both 0128 + 0129 are applied; 0097 stays unapplied otherwise
--      so the cron doesn't fire against the old function body).
--   3. Writers: crm.enrolments (status flip), audit.actions, calls
--      crm.sync_leads_to_brevo for the flipped IDs.
--   4. Rollback: replace with the original (learner-only, hardcoded 14d)
--      body. Safe iff no flips have run with the new body yet.
--   5. Sign-off: owner pending.

BEGIN;

CREATE OR REPLACE FUNCTION crm.run_enrolment_auto_flip()
RETURNS TABLE(flipped_count integer, sample_submission_ids bigint[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'crm', 'leads', 'audit', 'public'
AS $function$
DECLARE
  r                    RECORD;
  v_flipped            INTEGER := 0;
  v_sample             BIGINT[] := ARRAY[]::BIGINT[];
  v_flipped_ids        BIGINT[] := ARRAY[]::BIGINT[];
  v_dispute_deadline   TIMESTAMPTZ;
  v_existing           crm.enrolments%ROWTYPE;
  v_enrolment_id       BIGINT;
  v_target_status      TEXT;
BEGIN
  -- Pull every routing-log row whose routed_at sits past the provider's
  -- per-row sla_presumed_flip_days threshold, where the provider has
  -- auto_flip_enabled = true AND has accepted the SLA. Same DISTINCT ON
  -- as the original to take the most recent routing_log per submission.
  FOR r IN
    SELECT DISTINCT ON (rl.submission_id)
      rl.id           AS routing_log_id,
      rl.submission_id,
      rl.provider_id,
      rl.routed_at,
      s.lead_type,
      p.sla_presumed_flip_days
      FROM leads.routing_log rl
      JOIN leads.submissions s ON s.id = rl.submission_id
      JOIN crm.providers     p ON p.provider_id = rl.provider_id
     WHERE rl.routed_at < now() - (p.sla_presumed_flip_days || ' days')::interval
       AND s.is_dq = false
       AND s.archived_at IS NULL
       AND p.auto_flip_enabled  = true
       AND p.sla_accepted_at IS NOT NULL
       AND p.archived_at IS NULL
     ORDER BY rl.submission_id, rl.routed_at DESC
  LOOP
    -- Skip if the lead has already moved off 'open'. The portal-side
    -- workflow (attempt_1/2/3, engaged, in_progress, signed/enrolled,
    -- lost/not_signed, cannot_reach) all count as "provider has
    -- engaged" — no auto-flip needed.
    SELECT * INTO v_existing
      FROM crm.enrolments
     WHERE submission_id = r.submission_id
       AND provider_id   = r.provider_id
     LIMIT 1;
    IF v_existing.id IS NOT NULL AND v_existing.status <> 'open' THEN
      CONTINUE;
    END IF;

    -- Target status diverges by lead_type. Learner → presumed_enrolled;
    -- employer → presumed_employer_signed. Both share the same 7-day
    -- dispute window post-flip.
    v_target_status := CASE
      WHEN r.lead_type = 'employer_apprenticeship' THEN 'presumed_employer_signed'
      ELSE 'presumed_enrolled'
    END;
    v_dispute_deadline := now() + INTERVAL '7 days';

    INSERT INTO crm.enrolments (
      submission_id, routing_log_id, provider_id, status,
      sent_to_provider_at, status_updated_at,
      presumed_deadline_at, dispute_deadline_at
    ) VALUES (
      r.submission_id, r.routing_log_id, r.provider_id, v_target_status,
      r.routed_at, now(),
      now(), v_dispute_deadline
    )
    ON CONFLICT (submission_id, provider_id) DO UPDATE SET
      status               = v_target_status,
      status_updated_at    = now(),
      presumed_deadline_at = now(),
      dispute_deadline_at  = v_dispute_deadline,
      updated_at           = now()
    RETURNING id INTO v_enrolment_id;

    PERFORM audit.log_system_action(
      p_actor        := 'system:cron:enrolment-auto-flip',
      p_action       := 'auto_flip_to_presumed',
      p_target_table := 'crm.enrolments',
      p_target_id    := v_enrolment_id::text,
      p_before       := CASE
        WHEN v_existing.id IS NOT NULL THEN jsonb_build_object('status', v_existing.status)
        ELSE NULL
      END,
      p_after        := jsonb_build_object(
        'status',              v_target_status,
        'dispute_deadline_at', v_dispute_deadline
      ),
      p_context      := jsonb_build_object(
        'submission_id',           r.submission_id,
        'provider_id',             r.provider_id,
        'routed_at',               r.routed_at,
        'lead_type',               r.lead_type,
        'provider_threshold_days', r.sla_presumed_flip_days,
        'days_since_routed',       EXTRACT(DAY FROM now() - r.routed_at)::INT
      )
    );

    v_flipped     := v_flipped + 1;
    v_flipped_ids := array_append(v_flipped_ids, r.submission_id);
    IF coalesce(array_length(v_sample, 1), 0) < 10 THEN
      v_sample := array_append(v_sample, r.submission_id);
    END IF;
  END LOOP;

  IF coalesce(array_length(v_flipped_ids, 1), 0) > 0 THEN
    PERFORM crm.sync_leads_to_brevo(v_flipped_ids);
  END IF;

  RETURN QUERY SELECT v_flipped, v_sample;
END;
$function$;

COMMIT;
