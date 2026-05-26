-- Migration 0174 — crm.fire_sms_chaser_bulk RPC for manual batch SMS dispatch
-- Date: 2026-05-26
-- Author: Claude (Sasha, platform session) with owner sign-off
-- Reason:
--   Charlotte needs a bulk-send SMS chaser button on /admin/leads, mirroring
--   the existing email "Send chaser" bulk action. Auto-fire path stays
--   unchanged: providers click attempt_1_no_answer in the portal, one SMS
--   fires once per learner via crm.fire_sms_chaser_attempt_1 (migration 0157).
--   This manual batch path is for cases where the auto-fire didn't happen
--   (e.g. provider jumped straight to attempt_2) or where Charlotte wants to
--   re-push a second nudge to a learner whose last SMS was >24h ago.
--
--   Sibling of crm.fire_provider_chaser (email bulk, migration 0086). Differs
--   in two ways: (a) takes a 24h cooldown window instead of once-ever, so
--   the same batch can be re-fired tomorrow; (b) async-fires the existing
--   sms-chaser-attempt-1 Edge Function with a cooldown_hours=24 body arg
--   so sendSms windows its idempotency check to match.
--
-- Related:
--   platform/supabase/migrations/0157_add_sms_chaser_rpc.sql (singular RPC, auto-fire)
--   platform/supabase/migrations/0086_drop_last_chaser_at.sql (sibling email bulk RPC)
--   platform/supabase/functions/sms-chaser-attempt-1/index.ts (receiver — extended in same session)
--   platform/supabase/functions/_shared/sms-utility.ts (fireChaserSms — extended)
--   platform/supabase/functions/_shared/brevo.ts (sendSms — cooldownHours added)
--   platform/app/app/admin/leads/bulk-actions.ts (new fireSmsChaser server action)
--   platform/app/app/admin/leads/bulk-selection.tsx (new "Send SMS chaser" button)
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new SECURITY DEFINER function crm.fire_sms_chaser_bulk. No
--      DDL on existing tables, no new schema or role.
--   2. Readers: new server action fireSmsChaser calls this via
--      supabase.schema("crm").rpc(...). No other consumer.
--   3. Writers: function writes an audit row per submission via
--      audit.log_action and one pg_net.http_post per eligible submission.
--      No direct table writes.
--   4. Schema_version: no contract bumped.
--   5. Data migration: none.
--   6. New role / policy: none. SECURITY DEFINER; authenticated gets EXECUTE.
--   7. Rollback: DROP FUNCTION in DOWN block.
--   8. Sign-off: owner 2026-05-26.

BEGIN;

CREATE OR REPLACE FUNCTION crm.fire_sms_chaser_bulk(p_submission_ids BIGINT[])
RETURNS TABLE(submission_id BIGINT, status TEXT, reason TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm, leads, audit, public, net
AS $$
DECLARE
  r              RECORD;
  v_secret       TEXT;
  v_url          TEXT := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/sms-chaser-attempt-1';
  v_req_id       BIGINT;
  v_recent_count INT;
BEGIN
  IF p_submission_ids IS NULL OR array_length(p_submission_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  v_secret := public.get_shared_secret('AUDIT_SHARED_SECRET');

  FOR r IN
    SELECT
      s.id                AS sub_id,
      s.phone             AS phone,
      s.archived_at       AS archived_at,
      s.is_dq             AS is_dq,
      s.primary_routed_to AS provider_id
    FROM unnest(p_submission_ids) WITH ORDINALITY AS x(sub_id, ord)
    JOIN leads.submissions s ON s.id = x.sub_id
    ORDER BY x.ord
  LOOP
    IF r.archived_at IS NOT NULL THEN
      submission_id := r.sub_id; status := 'skipped'; reason := 'archived';
      RETURN NEXT; CONTINUE;
    END IF;

    IF r.phone IS NULL OR r.phone = '' THEN
      submission_id := r.sub_id; status := 'skipped'; reason := 'no phone';
      RETURN NEXT; CONTINUE;
    END IF;

    IF r.provider_id IS NULL THEN
      submission_id := r.sub_id; status := 'skipped'; reason := 'not routed';
      RETURN NEXT; CONTINUE;
    END IF;

    -- 24h cooldown: skip if a non-failed chaser SMS landed in the last 24h.
    -- Mirrors the windowed check sendSms will run inside the EF; doing it
    -- here too makes the UI counts accurate (the EF call is fire-and-forget
    -- via pg_net so we can't read its return). Keeping both gates is
    -- intentional — the EF protects against race conditions if Charlotte
    -- double-clicks the bulk button, the RPC gate produces honest counts.
    SELECT COUNT(*) INTO v_recent_count
      FROM crm.sms_log sl
     WHERE sl.submission_id = r.sub_id
       AND sl.comm_type     = 'chaser_call_attempt'
       AND sl.status IN ('queued','sent','delivered')
       AND sl.triggered_at  > now() - interval '24 hours';

    IF v_recent_count > 0 THEN
      submission_id := r.sub_id; status := 'skipped';
      reason := 'sms sent within last 24h';
      RETURN NEXT; CONTINUE;
    END IF;

    -- Audit the manual batch fire intent. The actual send + canonical sms_log
    -- row is written by the EF via sendSms. Distinguishes from the singular
    -- auto-fire RPC's audit (fire_sms_chaser_attempt_1) so we can trace which
    -- path drove each send.
    PERFORM audit.log_action(
      p_action       := 'fire_sms_chaser_bulk',
      p_target_table := 'crm.sms_log',
      p_target_id    := r.sub_id::text,
      p_before       := NULL,
      p_after        := jsonb_build_object('sms_chaser_fired_at', now()),
      p_context      := jsonb_build_object(
        'submission_id', r.sub_id,
        'provider_id',   r.provider_id,
        'cooldown_hours', 24
      ),
      p_surface      := 'admin'
    );

    SELECT net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-audit-key',  v_secret
      ),
      body    := jsonb_build_object(
        'submission_id', r.sub_id,
        'cooldown_hours', 24
      ),
      timeout_milliseconds := 30000
    ) INTO v_req_id;

    submission_id := r.sub_id; status := 'ok'; reason := NULL;
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$$;

COMMENT ON FUNCTION crm.fire_sms_chaser_bulk(BIGINT[]) IS
  'Bulk-fires the chaser SMS for the given submission ids, with a 24h cooldown window (skip if any non-failed chaser SMS landed in the last 24h). Audits per-row intent and async-fires the sms-chaser-attempt-1 Edge Function via pg_net with cooldown_hours=24 in the body so sendSms windows its idempotency check to match. Sibling of crm.fire_provider_chaser (email bulk, migration 0086) and crm.fire_sms_chaser_attempt_1 (singular auto-fire, migration 0157). Returns per-id status (ok / skipped + reason).';

GRANT EXECUTE ON FUNCTION crm.fire_sms_chaser_bulk(BIGINT[]) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP FUNCTION IF EXISTS crm.fire_sms_chaser_bulk(BIGINT[]);
-- COMMIT;
