-- Migration 0046 — chaser tracking + fire-chaser RPC
-- Date: 2026-04-30
-- Author: Claude (platform session) with owner sign-off
-- Reason: Owner needs a one-click way to bulk-trigger the SF2 "Provider
-- tried no answer" Brevo automation from /admin/leads. SF2 fires when a
-- contact is added to the internal "Provider tried no answer" list in
-- Brevo (auto-removes at end of flow, so re-adding re-fires the chaser).
-- Today this is a 3-click manual operation in Brevo's UI per lead. At
-- volume that's ~5 minutes a day of pure friction.
--
-- Adds:
--   1. crm.enrolments.last_chaser_at TIMESTAMPTZ — when the provider
--      chaser was last triggered for this enrolment. NULL = never.
--      Surfaced in the dashboard so owner can avoid double-firing.
--   2. crm.fire_provider_chaser(BIGINT[]) — SECURITY DEFINER. Looks up
--      each submission's email, calls the new admin-brevo-chase Edge
--      Function async via pg_net, stamps last_chaser_at on the
--      enrolment row, writes an audit row. Returns the count fired.
--
-- Failure modes (best-effort, same posture as the other Brevo paths):
--   - Submission has no email → skip, no error
--   - No enrolment row (lead never routed) → skip with reason
--   - pg_net or Brevo failure → row lands in leads.dead_letter from
--     inside admin-brevo-chase. last_chaser_at still stamped — the
--     owner's intent was recorded, the dead_letter shows the failure.
--
-- Related:
--   - platform/supabase/functions/admin-brevo-chase (target Edge
--     Function, deployed alongside this migration)
--   - platform/supabase/functions/_shared/brevo.ts (addBrevoContactToList)

-- UP

ALTER TABLE crm.enrolments
  ADD COLUMN IF NOT EXISTS last_chaser_at TIMESTAMPTZ;

COMMENT ON COLUMN crm.enrolments.last_chaser_at IS
  'When the SF2 Provider-tried-no-answer Brevo chaser was last triggered for this enrolment. NULL = never. Stamped by crm.fire_provider_chaser. Surfaced in /admin/leads to prevent double-firing.';

CREATE OR REPLACE FUNCTION crm.fire_provider_chaser(p_submission_ids BIGINT[])
RETURNS TABLE(submission_id BIGINT, email TEXT, status TEXT, reason TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm, leads, audit, public, net
AS $$
DECLARE
  r              RECORD;
  v_secret       TEXT;
  v_url          TEXT := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/admin-brevo-chase';
  v_emails       TEXT[] := ARRAY[]::TEXT[];
  v_fired_ids    BIGINT[] := ARRAY[]::BIGINT[];
  v_req_id       BIGINT;
BEGIN
  IF p_submission_ids IS NULL OR array_length(p_submission_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  -- Resolve every submission_id → email + enrolment row eligibility, return
  -- per-id status to the caller. Eligible rows get last_chaser_at stamped
  -- and their email queued for the Brevo list-add.
  FOR r IN
    SELECT
      s.id        AS sub_id,
      s.email     AS email,
      s.archived_at AS archived_at,
      s.is_dq     AS is_dq,
      e.id        AS enrol_id,
      e.provider_id AS provider_id,
      e.status    AS enrol_status
    FROM unnest(p_submission_ids) WITH ORDINALITY AS x(sub_id, ord)
    JOIN leads.submissions s ON s.id = x.sub_id
    LEFT JOIN crm.enrolments e ON e.submission_id = s.id
    ORDER BY x.ord
  LOOP
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

    -- Stamp last_chaser_at on the enrolment row.
    UPDATE crm.enrolments
       SET last_chaser_at = now(),
           updated_at     = now()
     WHERE id = r.enrol_id;

    -- Audit the chaser fire.
    PERFORM audit.log_action(
      p_action       := 'fire_provider_chaser',
      p_target_table := 'crm.enrolments',
      p_target_id    := r.enrol_id::text,
      p_before       := NULL,
      p_after        := jsonb_build_object('last_chaser_at', now()),
      p_context      := jsonb_build_object(
        'submission_id', r.sub_id,
        'provider_id',   r.provider_id,
        'enrol_status',  r.enrol_status
      ),
      p_surface      := 'admin'
    );

    v_emails := array_append(v_emails, lower(r.email));
    v_fired_ids := array_append(v_fired_ids, r.sub_id);

    submission_id := r.sub_id; email := r.email; status := 'ok';
    reason := NULL;
    RETURN NEXT;
  END LOOP;

  -- Single Brevo call covering every successfully-stamped lead. The Edge
  -- Function adds them to the BREVO_LIST_ID_PROVIDER_TRIED_NO_ANSWER
  -- internal list; SF2 fires + auto-removes them. Async via pg_net so the
  -- caller doesn't block.
  IF array_length(v_emails, 1) > 0 THEN
    v_secret := public.get_shared_secret('AUDIT_SHARED_SECRET');
    SELECT net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-audit-key',  v_secret
      ),
      body    := jsonb_build_object(
        'emails', to_jsonb(v_emails),
        'submissionIds', to_jsonb(v_fired_ids)
      ),
      timeout_milliseconds := 60000
    ) INTO v_req_id;
  END IF;

  RETURN;
END;
$$;

COMMENT ON FUNCTION crm.fire_provider_chaser(BIGINT[]) IS
  'Bulk-fires the SF2 Provider-tried-no-answer Brevo chaser for the given submission ids. Stamps crm.enrolments.last_chaser_at, audits, and async-fires admin-brevo-chase to add the emails to the Brevo internal list. Returns per-id status (ok / skipped + reason). Migration 0046.';

REVOKE ALL ON FUNCTION crm.fire_provider_chaser(BIGINT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.fire_provider_chaser(BIGINT[]) TO authenticated;

-- DOWN
-- DROP FUNCTION IF EXISTS crm.fire_provider_chaser(BIGINT[]);
-- ALTER TABLE crm.enrolments DROP COLUMN IF EXISTS last_chaser_at;
