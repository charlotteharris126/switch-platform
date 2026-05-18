-- Migration 0149 — fire_employer_chaser uses log_system_action_v1 for audit
-- Date: 2026-05-18
-- Author: Claude (Sasha session) with owner review
-- Reason:
--   crm.fire_employer_chaser (shipped in 0148) calls audit.log_action with
--   p_surface := 'admin'. The admin surface gate requires auth.uid() +
--   email — fine for the auto-fire path from markOutcomeAction (the user's
--   JWT flows through), but blocks any manual SQL-editor invocation
--   because the SQL editor runs as the postgres superuser with no auth
--   context.
--
--   Hit when manually firing the 3 in-flight Riverside backfills tonight
--   (subs 468, 486, 487): the function tripped the audit gate before any
--   email could go out. Charlotte fell back to a direct pg_net.http_post
--   against admin-brevo-chase-employer, which got the chasers sent but
--   left no audit.actions row for the manual fire.
--
--   This migration rewrites the function to use public.log_system_action_v1
--   (migration 0147) instead of audit.log_action(p_surface := 'admin').
--   The actor is recorded explicitly via p_actor (auth.email() when
--   present, 'system' otherwise) and the auth user id is preserved in
--   p_context for traceability. Behaviour is unchanged for the
--   auto-fire path; the only difference is the audit surface is 'system'
--   not 'admin', and SQL-editor manual fires no longer trip the gate.
--
--   The sibling crm.fire_provider_chaser is NOT migrated in this pass —
--   it has the same pattern but is only ever invoked from authenticated
--   app paths (markOutcomeAction + admin bulk-actions). Carry as a future
--   tidy-up if a manual-fire need arises learner-side.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: CREATE OR REPLACE the function body. No signature change.
--   2. Readers: audit.actions consumers (admin /admin/audit page if/when
--      it surfaces employer-chaser fires) — rows now appear under
--      surface='system' with action='fire_employer_chaser'.
--   3. Writers: still only this function.
--   4. Rollback: re-apply 0148's function body (see DOWN).
--   5. Sign-off: owner (Charlotte) in session 2026-05-18.

BEGIN;

CREATE OR REPLACE FUNCTION crm.fire_employer_chaser(p_submission_ids BIGINT[])
RETURNS TABLE(submission_id BIGINT, email TEXT, status TEXT, reason TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm, leads, audit, public, net
AS $$
DECLARE
  r              RECORD;
  v_secret       TEXT;
  v_url          TEXT := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/admin-brevo-chase-employer';
  v_fired_ids    BIGINT[] := ARRAY[]::BIGINT[];
  v_req_id       BIGINT;
  v_actor_email  TEXT;
  v_actor_uid    UUID;
BEGIN
  IF p_submission_ids IS NULL OR array_length(p_submission_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  -- Best-effort capture of auth context. Both can be NULL for
  -- SQL-editor / cron / pg_net invocations; log_system_action_v1 accepts
  -- a plain text actor so we fall back to 'system'.
  BEGIN
    v_actor_email := auth.email();
  EXCEPTION WHEN OTHERS THEN
    v_actor_email := NULL;
  END;
  BEGIN
    v_actor_uid := auth.uid();
  EXCEPTION WHEN OTHERS THEN
    v_actor_uid := NULL;
  END;

  FOR r IN
    SELECT
      s.id          AS sub_id,
      s.email       AS email,
      s.archived_at AS archived_at,
      s.is_dq       AS is_dq,
      s.lead_type   AS lead_type,
      e.id          AS enrol_id,
      e.provider_id AS provider_id,
      e.status      AS enrol_status
    FROM unnest(p_submission_ids) WITH ORDINALITY AS x(sub_id, ord)
    JOIN leads.submissions s ON s.id = x.sub_id
    LEFT JOIN crm.enrolments e ON e.submission_id = s.id
    ORDER BY x.ord
  LOOP
    IF r.lead_type IS DISTINCT FROM 'employer_apprenticeship' THEN
      submission_id := r.sub_id; email := r.email; status := 'skipped';
      reason := 'not an employer lead';
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF r.email IS NULL OR r.email = '' THEN
      submission_id := r.sub_id; email := NULL; status := 'skipped';
      reason := 'no email';
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF r.archived_at IS NOT NULL THEN
      submission_id := r.sub_id; email := r.email; status := 'skipped';
      reason := 'archived';
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF r.enrol_id IS NULL THEN
      submission_id := r.sub_id; email := r.email; status := 'skipped';
      reason := 'no enrolment row (lead never routed)';
      RETURN NEXT;
      CONTINUE;
    END IF;

    UPDATE crm.enrolments
       SET updated_at = now()
     WHERE id = r.enrol_id;

    PERFORM public.log_system_action_v1(
      p_actor        := COALESCE(v_actor_email, 'system'),
      p_action       := 'fire_employer_chaser',
      p_target_table := 'crm.enrolments',
      p_target_id    := r.enrol_id::text,
      p_before       := NULL,
      p_after        := jsonb_build_object('chaser_fired_at', now()),
      p_context      := jsonb_build_object(
        'submission_id', r.sub_id,
        'provider_id',   r.provider_id,
        'enrol_status',  r.enrol_status,
        'lead_type',     r.lead_type,
        'actor_user_id', v_actor_uid
      )
    );

    v_fired_ids := array_append(v_fired_ids, r.sub_id);

    submission_id := r.sub_id; email := r.email; status := 'ok';
    reason := NULL;
    RETURN NEXT;
  END LOOP;

  IF array_length(v_fired_ids, 1) > 0 THEN
    v_secret := public.get_shared_secret('AUDIT_SHARED_SECRET');
    SELECT net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-audit-key',  v_secret
      ),
      body    := jsonb_build_object(
        'submissionIds', to_jsonb(v_fired_ids)
      ),
      timeout_milliseconds := 60000
    ) INTO v_req_id;
  END IF;

  RETURN;
END;
$$;

COMMENT ON FUNCTION crm.fire_employer_chaser(BIGINT[]) IS
  'Bulk-fires the S4B employer chaser for the given employer_apprenticeship submission ids. Filters to lead_type=employer_apprenticeship as a safety belt. Audits via public.log_system_action_v1 (system surface) so SQL-editor / cron / pg_net invocations do not trip the admin-surface auth.uid() gate. Auth context (when present) is captured into p_context.actor_user_id + p_actor. Async-fires admin-brevo-chase-employer via pg_net. No legacy Brevo list-add (transactional only). Migrations 0148 + 0149.';

REVOKE ALL ON FUNCTION crm.fire_employer_chaser(BIGINT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.fire_employer_chaser(BIGINT[]) TO authenticated;

COMMIT;

-- DOWN
-- BEGIN;
-- Re-apply 0148's function body: audit.log_action with p_surface := 'admin'.
-- See migration 0148 for the full original body.
-- COMMIT;
