-- Migration 0023 — Enrolment auto-flip cron + system-actor audit support
-- Date: 2026-04-25
-- Author: Claude (platform Session D) with owner sign-off
-- Reason: The pilot SLA says any routed lead with no status update from the
--         provider after 14 days auto-flips to 'presumed_enrolled', and the
--         provider has 7 days to dispute before billing. Today this lives
--         as a Google Sheets formula on each provider's tracker — works,
--         but only the provider sees it, never reaches our DB. Without
--         server-side enforcement: no audit trail, no billing trigger, no
--         dashboard visibility.
--
--         First test fires Sun 3 May (Susan Waldby — first EMS lead, sent
--         2026-04-19, 14 days = 2026-05-03). Cron must be live before then.
--
--         This migration ships:
--
--         1. audit.actions schema tweak — `actor_user_id` becomes nullable,
--            `actor_email` follows. CHECK constraint enforces:
--              system surface → actor_user_id NULL,  actor_email present (a
--                system identifier like 'system:cron:enrolment-auto-flip')
--              admin/provider surface → both NOT NULL
--            Required so cron-triggered audit rows don't synthesise a fake
--            auth.users entry.
--
--         2. audit.log_system_action() helper — separate from log_action()
--            so each function stays single-purpose. Validates input,
--            requires the caller to pass a non-empty actor identifier.
--
--         3. crm.run_enrolment_auto_flip() — finds routed leads >14d old
--            without a terminal-state enrolment, upserts to
--            'presumed_enrolled' with the 7-day dispute window. One audit
--            row per flip. Returns count + sample of flipped IDs for cron
--            log visibility.
--
--         4. pg_cron schedule — daily at 06:00 UTC. Reads no secrets, calls
--            the SECURITY DEFINER function directly, no auth header to
--            drift.
--
-- Related: platform/supabase/migrations/0020_audit_log_action_helper.sql,
--          platform/supabase/migrations/0022_enrolment_outcome_helper.sql.

-- UP

-- =============================================================================
-- 1. audit.actions schema tweak (allow system rows)
-- =============================================================================

ALTER TABLE audit.actions ALTER COLUMN actor_user_id DROP NOT NULL;
ALTER TABLE audit.actions ALTER COLUMN actor_email DROP NOT NULL;

ALTER TABLE audit.actions DROP CONSTRAINT IF EXISTS audit_actions_actor_present_chk;
ALTER TABLE audit.actions
  ADD CONSTRAINT audit_actions_actor_present_chk CHECK (
    (surface = 'system' AND actor_user_id IS NULL AND actor_email IS NOT NULL)
    OR (surface IN ('admin', 'provider') AND actor_user_id IS NOT NULL AND actor_email IS NOT NULL)
  );

-- =============================================================================
-- 2. audit.log_system_action() helper
-- =============================================================================

CREATE OR REPLACE FUNCTION audit.log_system_action(
  p_actor         TEXT,        -- 'system:cron:enrolment-auto-flip', etc.
  p_action        TEXT,
  p_target_table  TEXT DEFAULT NULL,
  p_target_id     TEXT DEFAULT NULL,
  p_before        JSONB DEFAULT NULL,
  p_after         JSONB DEFAULT NULL,
  p_context       JSONB DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit, public
AS $$
DECLARE
  v_new_id BIGINT;
BEGIN
  IF p_actor IS NULL OR length(trim(p_actor)) = 0 THEN
    RAISE EXCEPTION 'system audit writes require a non-empty actor identifier (e.g. ''system:cron:enrolment-auto-flip'')'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_action IS NULL OR length(trim(p_action)) = 0 THEN
    RAISE EXCEPTION 'Action is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  INSERT INTO audit.actions (
    actor_user_id, actor_email, surface, action,
    target_table, target_id, before_value, after_value, context
  ) VALUES (
    NULL, p_actor, 'system', p_action,
    p_target_table, p_target_id, p_before, p_after, p_context
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

COMMENT ON FUNCTION audit.log_system_action(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB) IS
  'Append-only audit write for cron jobs and other system-triggered actions. actor_user_id is NULL by design (no auth context); actor_email holds a system identifier like ''system:cron:enrolment-auto-flip''. Distinct from audit.log_action() which gates on auth.uid()/auth.jwt(). Added migration 0023.';

REVOKE ALL ON FUNCTION audit.log_system_action(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB) FROM PUBLIC;
-- Only postgres (which pg_cron jobs run as) needs to call this. Not granted
-- to authenticated — admin writes use audit.log_action with auth context.
GRANT EXECUTE ON FUNCTION audit.log_system_action(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB) TO postgres;

-- =============================================================================
-- 3. crm.run_enrolment_auto_flip()
-- =============================================================================

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
  v_dispute_deadline   TIMESTAMPTZ := now() + INTERVAL '7 days';
  v_existing           crm.enrolments%ROWTYPE;
  v_enrolment_id       BIGINT;
BEGIN
  -- Most recent routing per submission, > 14 days ago, on a non-DQ active row.
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
    -- Skip if a terminal-state enrolment already exists. We only flip rows
    -- that are NULL or in early-state (open / contacted).
    SELECT *
      INTO v_existing
      FROM crm.enrolments
     WHERE submission_id = r.submission_id
       AND provider_id   = r.provider_id
     LIMIT 1;

    IF v_existing.id IS NOT NULL
       AND v_existing.status NOT IN ('open', 'contacted') THEN
      CONTINUE;
    END IF;

    -- Upsert
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

    -- Audit
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
    IF coalesce(array_length(v_sample, 1), 0) < 10 THEN
      v_sample := array_append(v_sample, r.submission_id);
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_flipped, v_sample;
END;
$$;

COMMENT ON FUNCTION crm.run_enrolment_auto_flip() IS
  'Daily cron entry point. Flips routed leads >14 days old without a terminal-state enrolment to status=''presumed_enrolled'' and sets a 7-day dispute deadline. Audit row per flip via audit.log_system_action. Returns flipped count + up to 10 sample submission ids for cron log visibility. Added migration 0023.';

REVOKE ALL ON FUNCTION crm.run_enrolment_auto_flip() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.run_enrolment_auto_flip() TO postgres;

-- =============================================================================
-- 4. Cron schedule
-- =============================================================================
-- 06:00 UTC = 07:00 BST in summer, 06:00 GMT in winter — early enough that
-- providers see the new presumed-state on their morning sheet review.
-- pg_cron runs as the postgres role, which has EXECUTE on the function above.

SELECT cron.schedule(
  'enrolment-auto-flip-daily',
  '0 6 * * *',
  $$SELECT crm.run_enrolment_auto_flip();$$
);

-- DOWN
-- SELECT cron.unschedule('enrolment-auto-flip-daily');
-- DROP FUNCTION IF EXISTS crm.run_enrolment_auto_flip();
-- REVOKE EXECUTE ON FUNCTION audit.log_system_action(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB) FROM postgres;
-- DROP FUNCTION IF EXISTS audit.log_system_action(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB);
-- ALTER TABLE audit.actions DROP CONSTRAINT IF EXISTS audit_actions_actor_present_chk;
-- ALTER TABLE audit.actions ALTER COLUMN actor_email SET NOT NULL;
-- ALTER TABLE audit.actions ALTER COLUMN actor_user_id SET NOT NULL;
