-- Migration 0157 — crm.fire_sms_chaser_attempt_1 RPC for SMS chaser dispatch
-- Date: 2026-05-21
-- Author: Claude (Sasha, platform session) with owner sign-off
-- Reason:
--   Chunk 2 of SMS utility build per `switchable/email/docs/sms-utility-design.md`
--   (Wren, locked 2026-05-21). Trigger C (chaser SMS on attempt_1_no_answer)
--   fires from the server action `markOutcomeAction` in the provider portal.
--   Server actions call this RPC alongside the existing
--   `crm.fire_provider_chaser` (email chaser) RPC. This function async-fires
--   the new `sms-chaser-attempt-1` Edge Function via pg_net.http_post, mirroring
--   the existing email chaser dispatch pattern from migration 0086.
--
--   Eligibility filters here are the lightweight ones (submission exists, has
--   phone, is matched to a provider). The Edge Function runs the full gates
--   (funding_category in gov/loan, provider.sms_chaser_enabled, regional rep
--   phone resolves, sms_log idempotency on chaser_call_attempt).
--
-- Related:
--   platform/supabase/functions/sms-chaser-attempt-1/index.ts (receiver)
--   platform/supabase/functions/_shared/sms-utility.ts (fireChaserSms + gates)
--   platform/supabase/functions/_shared/brevo.ts (sendSms helper)
--   platform/app/app/provider/leads/[id]/actions.ts (caller — markOutcomeAction)
--   platform/supabase/migrations/0086_drop_last_chaser_at.sql (sibling email chaser RPC)
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new SECURITY DEFINER function crm.fire_sms_chaser_attempt_1.
--      No new table, no data migration, no DDL on existing tables.
--   2. Readers: server action `markOutcomeAction` calls this via
--      supabase.schema("crm").rpc(...). No other consumer.
--   3. Writers: function itself writes an audit row via audit.log_action and
--      pg_net.http_posts the EF. No direct table writes.
--   4. Schema_version: no contract bumped.
--   5. Data migration: none.
--   6. New role / policy: none. Function is SECURITY DEFINER, runs with the
--      definer's privileges (postgres). authenticated role gets EXECUTE.
--   7. Rollback: DROP FUNCTION in DOWN block.
--   8. Sign-off: owner 2026-05-21.

BEGIN;

CREATE OR REPLACE FUNCTION crm.fire_sms_chaser_attempt_1(p_submission_id BIGINT)
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
BEGIN
  IF p_submission_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    s.id          AS sub_id,
    s.phone       AS phone,
    s.archived_at AS archived_at,
    s.is_dq       AS is_dq,
    s.primary_routed_to AS provider_id
  INTO r
    FROM leads.submissions s
   WHERE s.id = p_submission_id
   LIMIT 1;

  IF r IS NULL THEN
    submission_id := p_submission_id; status := 'skipped';
    reason := 'submission not found';
    RETURN NEXT;
    RETURN;
  END IF;

  IF r.archived_at IS NOT NULL THEN
    submission_id := r.sub_id; status := 'skipped'; reason := 'archived';
    RETURN NEXT; RETURN;
  END IF;

  IF r.phone IS NULL OR r.phone = '' THEN
    submission_id := r.sub_id; status := 'skipped'; reason := 'no phone';
    RETURN NEXT; RETURN;
  END IF;

  IF r.provider_id IS NULL THEN
    submission_id := r.sub_id; status := 'skipped'; reason := 'not routed';
    RETURN NEXT; RETURN;
  END IF;

  -- Audit the SMS chaser-fire intent. The actual send + canonical sms_log
  -- row is written by sms-chaser-attempt-1 (Edge Function) via sendSms.
  PERFORM audit.log_action(
    p_action       := 'fire_sms_chaser_attempt_1',
    p_target_table := 'crm.sms_log',
    p_target_id    := r.sub_id::text,
    p_before       := NULL,
    p_after        := jsonb_build_object('sms_chaser_fired_at', now()),
    p_context      := jsonb_build_object(
      'submission_id', r.sub_id,
      'provider_id',   r.provider_id
    ),
    p_surface      := 'admin'
  );

  v_secret := public.get_shared_secret('AUDIT_SHARED_SECRET');
  SELECT net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-audit-key',  v_secret
    ),
    body    := jsonb_build_object(
      'submission_id', r.sub_id
    ),
    timeout_milliseconds := 30000
  ) INTO v_req_id;

  submission_id := r.sub_id; status := 'ok'; reason := NULL;
  RETURN NEXT;
  RETURN;
END;
$$;

COMMENT ON FUNCTION crm.fire_sms_chaser_attempt_1(BIGINT) IS
  'Async-fires the chaser SMS via pg_net to the sms-chaser-attempt-1 Edge Function. Lightweight eligibility gates here (exists, has phone, routed); full gates (funding_category, provider.sms_chaser_enabled, regional rep phone, sms_log idempotency) run inside the Edge Function. Sister to crm.fire_provider_chaser (email chaser) from migration 0086. Migration 0157.';

GRANT EXECUTE ON FUNCTION crm.fire_sms_chaser_attempt_1(BIGINT) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP FUNCTION IF EXISTS crm.fire_sms_chaser_attempt_1(BIGINT);
-- COMMIT;
