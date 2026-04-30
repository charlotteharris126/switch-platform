-- Migration 0044 — crm.sync_leads_to_brevo helper for status-change Brevo push
-- Date: 2026-04-30
-- Author: Claude (platform session) with owner sign-off
-- Reason: When the owner marks a lead's enrolment outcome via /admin/leads
-- (single-lead form or bulk action), crm.enrolments.status updates but Brevo's
-- SW_ENROL_STATUS attribute stays stale until the next manual resync. This
-- breaks lifecycle-driven Brevo automations (U4 enrolment celebration, lost
-- recirc, presumed_enrolled hold, etc.) — they fire on attribute changes but
-- the attribute never moves.
--
-- Closes the gap by giving Server Actions a one-call path to fire the
-- existing admin-brevo-resync Edge Function for any list of submission ids.
-- The function:
--   - Is SECURITY DEFINER so the calling role doesn't need direct vault
--     or pg_net access.
--   - Uses public.get_shared_secret('AUDIT_SHARED_SECRET') to retrieve the
--     audit key and pass it as the x-audit-key header to admin-brevo-resync.
--   - Fires asynchronously via pg_net.http_post — returns the request_id
--     immediately, doesn't block the calling transaction.
--   - Idempotent at the call boundary: re-firing for the same ids is safe
--     because admin-brevo-resync re-reads the latest DB state on each call.
--
-- Caller pattern (Server Actions in platform/app/app/admin/leads/...):
--   1. Call crm.upsert_enrolment_outcome(...) and check it succeeded.
--   2. Collect successfully-updated submission ids.
--   3. Call crm.sync_leads_to_brevo(<array>) once at the end.
-- Bulk action collects N ids and fires once; single-lead form passes a
-- single-element array. Either way, admin-brevo-resync runs the upserts
-- sequentially with its 250ms throttle so Brevo's rate limit is respected.
--
-- Failure handling:
--   - pg_net itself fails rarely (only on network or DNS issues). If it
--     does, the function returns NULL and the Server Action continues —
--     the DB write already succeeded, the Brevo sync is best-effort.
--   - Brevo upsert failures (e.g. 429) land in leads.dead_letter from
--     within admin-brevo-resync. Sasha's Monday audit catches a growing
--     dead_letter table.
--
-- Related:
--   - platform/supabase/functions/admin-brevo-resync (target endpoint)
--   - platform/supabase/migrations/0019_vault_helper_for_shared_secrets.sql
--     (public.get_shared_secret allowlist + pattern)
--   - platform/app/app/admin/leads/[id]/actions.ts (single-lead caller)
--   - platform/app/app/admin/leads/bulk-actions.ts (bulk caller)

-- UP

CREATE OR REPLACE FUNCTION crm.sync_leads_to_brevo(p_submission_ids BIGINT[])
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, net
AS $$
DECLARE
  v_secret TEXT;
  v_url    TEXT := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/admin-brevo-resync';
  v_req_id BIGINT;
BEGIN
  IF p_submission_ids IS NULL OR array_length(p_submission_ids, 1) IS NULL THEN
    RETURN NULL;
  END IF;

  v_secret := public.get_shared_secret('AUDIT_SHARED_SECRET');

  SELECT net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-audit-key',  v_secret
    ),
    body    := jsonb_build_object('submissionIds', to_jsonb(p_submission_ids)),
    timeout_milliseconds := 60000
  ) INTO v_req_id;

  RETURN v_req_id;
END;
$$;

COMMENT ON FUNCTION crm.sync_leads_to_brevo(BIGINT[]) IS
  'Fires admin-brevo-resync for the given submission ids so SW_ENROL_STATUS and other Brevo attributes catch up after a DB-side enrolment status change. Returns the pg_net request_id (or NULL if input was empty). Async — does not block. Added migration 0044.';

REVOKE ALL ON FUNCTION crm.sync_leads_to_brevo(BIGINT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.sync_leads_to_brevo(BIGINT[]) TO authenticated;

-- DOWN
-- DROP FUNCTION IF EXISTS crm.sync_leads_to_brevo(BIGINT[]);
