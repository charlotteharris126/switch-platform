-- Migration 0148 — employer chaser path (S4B v1)
-- Date: 2026-05-18
-- Author: Claude (Sasha session) with owner review
-- Reason:
--   Riverside (S4B v1 apprenticeship pilot) is now working real Employer
--   Leads through the provider portal. When Freya marks attempt_1 / 2 / 3 /
--   cannot_reach, markOutcomeAction's auto-fire branch already triggers,
--   but the downstream path was learner-only:
--     - crm.fire_provider_chaser → admin-brevo-chase → branches on
--       funding_category, which is NULL on employer_apprenticeship rows,
--       so the send was silently skipped.
--     - The learner-shaped chaser templates (chaser_funded / chaser_self)
--       would be the wrong message anyway — Riverside is contacting an
--       HRD/MD, not a ghosted learner.
--
--   Bit Riverside today (2026-05-18): submission #450 Haris and #468 Lee
--   Anthony both flipped to attempt_1_no_answer with a misleading system
--   note ("Learner chaser email auto-sent...") landing in lead_notes, but
--   no email actually sent.
--
--   This migration adds a parallel employer-side path:
--     1. New email_type 's4b_employer_chaser' on crm.email_log.
--     2. New SECURITY DEFINER function crm.fire_employer_chaser(BIGINT[])
--        that mirrors crm.fire_provider_chaser but: (a) filters on
--        lead_type='employer_apprenticeship' as a safety belt; (b) calls
--        admin-brevo-chase-employer (new Edge Function); (c) skips the
--        legacy Brevo list-add (employer side is transactional-only, no
--        SF2 list/automation).
--
--   The existing learner chaser block in markOutcomeAction is gated to
--   leadType === 'learner' in the same session (app/app/provider/leads/
--   [id]/actions.ts patch). Employer transitions call this new RPC.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: extend CHECK constraint on crm.email_log.email_type to allow
--      's4b_employer_chaser'. Add crm.fire_employer_chaser(BIGINT[]).
--   2. Readers of the new email_type: /admin/leads "Last chaser" column
--      (already reads via crm.vw_enrolments_with_latest_chaser, which
--      filters IN ('chaser_funded','chaser_self') — that view STAYS
--      learner-only, which is intentional; the admin chaser column is
--      learner-bulk-fire scoped). Iris / Mira analytics across email_log
--      pick up the new type once it appears.
--   3. Writers: admin-brevo-chase-employer (new Edge Function) via
--      sendTransactional. No other writers.
--   4. schema_version bump: none. New value on an existing enum-like
--      CHECK, additive only.
--   5. Data migration: none. No rows hold this type yet.
--   6. New role / RLS: none. GRANT EXECUTE to authenticated mirrors
--      crm.fire_provider_chaser.
--   7. Rollback: DROP FUNCTION + restore prior CHECK constraint (see DOWN
--      section). Safe as long as no s4b_employer_chaser rows exist; if
--      any have shipped, archive them in dead_letter or audit log before
--      rollback.
--   8. Sign-off: owner (Charlotte) in session 2026-05-18.

BEGIN;

-- 1. Extend crm.email_log.email_type CHECK to allow s4b_employer_chaser.
ALTER TABLE crm.email_log DROP CONSTRAINT IF EXISTS email_log_email_type_check;

ALTER TABLE crm.email_log
  ADD CONSTRAINT email_log_email_type_check
  CHECK (email_type = ANY (ARRAY[
    'u1_funded', 'u1_self',
    'stalled_funded', 'stalled_self',
    'chaser_funded', 'chaser_self',
    'u4_funded', 'u4_self',
    'n1', 'n2', 'n3',
    'referral_cold', 'referral_lost',
    'newsletter',
    'provider_presumed_warning',
    'provider_presumed_flipped',
    're_engagement',
    -- Switchable for Business v1 (employer apprenticeship leads)
    's4b_employer_u1',
    's4b_employer_ud',
    's4b_employer_chaser',
    -- Fastrack qualifying ack (migration 0146)
    'u_fastrack_qualified'
  ]::text[]));

-- 2. crm.fire_employer_chaser — sibling of crm.fire_provider_chaser.
--    Filters to lead_type='employer_apprenticeship'. Calls a new Edge
--    Function (admin-brevo-chase-employer) via pg_net. No legacy
--    list-add — employer side is transactional-only.
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
BEGIN
  IF p_submission_ids IS NULL OR array_length(p_submission_ids, 1) IS NULL THEN
    RETURN;
  END IF;

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

    PERFORM audit.log_action(
      p_action       := 'fire_employer_chaser',
      p_target_table := 'crm.enrolments',
      p_target_id    := r.enrol_id::text,
      p_before       := NULL,
      p_after        := jsonb_build_object('chaser_fired_at', now()),
      p_context      := jsonb_build_object(
        'submission_id', r.sub_id,
        'provider_id',   r.provider_id,
        'enrol_status',  r.enrol_status,
        'lead_type',     r.lead_type
      ),
      p_surface      := 'admin'
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
  'Bulk-fires the S4B employer chaser for the given employer_apprenticeship submission ids. Filters to lead_type=employer_apprenticeship as a safety belt. Audits the fire-intent and async-fires admin-brevo-chase-employer via pg_net. Returns per-id status (ok / skipped + reason). No legacy Brevo list-add (transactional only). Migration 0148.';

REVOKE ALL ON FUNCTION crm.fire_employer_chaser(BIGINT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.fire_employer_chaser(BIGINT[]) TO authenticated;

COMMIT;

-- DOWN
-- BEGIN;
-- DROP FUNCTION IF EXISTS crm.fire_employer_chaser(BIGINT[]);
-- ALTER TABLE crm.email_log DROP CONSTRAINT IF EXISTS email_log_email_type_check;
-- ALTER TABLE crm.email_log
--   ADD CONSTRAINT email_log_email_type_check
--   CHECK (email_type = ANY (ARRAY[
--     'u1_funded','u1_self','stalled_funded','stalled_self','chaser_funded','chaser_self',
--     'u4_funded','u4_self','n1','n2','n3','referral_cold','referral_lost',
--     'newsletter','provider_presumed_warning','provider_presumed_flipped','re_engagement',
--     's4b_employer_u1','s4b_employer_ud','u_fastrack_qualified'
--   ]::text[]));
-- COMMIT;
