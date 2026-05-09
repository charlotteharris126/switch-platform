-- Migration 0101 — Filter is_demo providers out of crm.sync_leads_to_brevo
-- Date:    2026-05-09
-- Author:  Claude (platform Session 37 / Sasha) on Charlotte's instruction
-- Reason:  Provider portal MVP introduces a demo provider (is_demo=true on
--          crm.providers, added migration 0093) for sales calls and dogfooding
--          P2-P4 of the build. The provider-portal-mvp-scoping doc binds:
--          "all dashboard views, billing calcs, and reconcile crons must
--          filter is_demo=true rows out so they do not pollute real metrics".
--          Brevo sync is the same kind of consumer — pushing demo learner
--          contacts into the live Brevo workspace would pollute every
--          marketing automation, the daily attribute reconcile, and the
--          consent reconcile, all for fake data.
--
--          Filtering inside crm.sync_leads_to_brevo covers every caller in
--          one place: the three triggers from migration 0098 (enrolment
--          inserts/updates, submission updates, provider-cascade), the
--          daily attribute reconcile cron from migration 0100, and any
--          Server Action / data-ops script that calls the function directly.
--          Single source of truth for "demo data does not reach Brevo".
--
--          Implementation: LEFT JOIN crm.providers and drop submission ids
--          whose primary_routed_to provider has is_demo=true. NULL provider
--          (not-yet-routed submissions) stays in via COALESCE — they could
--          be live leads waiting on owner confirmation.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: replace crm.sync_leads_to_brevo body with a pre-filter step
--      that drops demo-routed submission ids before dispatching to
--      admin-brevo-resync via pg_net.
--   2. Readers: function reads from leads.submissions and crm.providers.
--      Both are owned by the function-owning role, so SECURITY DEFINER
--      access stays unchanged.
--   3. Writers: every existing trigger + cron + direct caller of
--      crm.sync_leads_to_brevo. None affected for real (non-demo) data —
--      the filter is a no-op for live providers (no rows have is_demo=true
--      until data-ops/019 seeds the demo provider).
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role/policy: function stays SECURITY DEFINER, same search_path.
--   7. Rollback: revert to the pre-0101 body (CREATE OR REPLACE without
--      the filter step). DOWN section below.
--   8. Sign-off: owner (this session, 2026-05-09).
-- Related: 0093 (added is_demo flag), 0098 (auto-sync triggers), 0100
--          (daily attribute reconcile), provider-portal-mvp-scoping.md.

-- UP

CREATE OR REPLACE FUNCTION crm.sync_leads_to_brevo(p_submission_ids BIGINT[])
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'net'
AS $function$
DECLARE
  v_secret TEXT;
  v_url    TEXT := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/admin-brevo-resync';
  v_req_id BIGINT;
  v_filtered BIGINT[];
BEGIN
  IF p_submission_ids IS NULL OR array_length(p_submission_ids, 1) IS NULL THEN
    RETURN NULL;
  END IF;

  -- Drop demo-routed submission ids before dispatch. Single source of truth
  -- for "demo data must not reach Brevo" — covers every trigger + cron +
  -- direct caller.
  SELECT array_agg(s.id)
    INTO v_filtered
    FROM leads.submissions s
    LEFT JOIN crm.providers p ON p.provider_id = s.primary_routed_to
   WHERE s.id = ANY(p_submission_ids)
     AND COALESCE(p.is_demo, false) = false;

  IF v_filtered IS NULL OR array_length(v_filtered, 1) IS NULL THEN
    RETURN NULL;
  END IF;

  v_secret := public.get_shared_secret('AUDIT_SHARED_SECRET');

  SELECT net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-audit-key',  v_secret
    ),
    body    := jsonb_build_object('submissionIds', to_jsonb(v_filtered)),
    timeout_milliseconds := 60000
  ) INTO v_req_id;

  RETURN v_req_id;
END;
$function$;

COMMENT ON FUNCTION crm.sync_leads_to_brevo(BIGINT[]) IS
  'Dispatches admin-brevo-resync (Edge Function) over the given submission ids via pg_net. Filters out submissions whose primary_routed_to provider has is_demo=true (added migration 0101) so demo data never reaches Brevo. NULL/empty input or fully-filtered input returns NULL without dispatch.';

-- DOWN
-- CREATE OR REPLACE FUNCTION crm.sync_leads_to_brevo(p_submission_ids BIGINT[])
-- RETURNS BIGINT
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path TO 'pg_catalog', 'public', 'net'
-- AS $function$
-- DECLARE
--   v_secret TEXT;
--   v_url    TEXT := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/admin-brevo-resync';
--   v_req_id BIGINT;
-- BEGIN
--   IF p_submission_ids IS NULL OR array_length(p_submission_ids, 1) IS NULL THEN
--     RETURN NULL;
--   END IF;
--   v_secret := public.get_shared_secret('AUDIT_SHARED_SECRET');
--   SELECT net.http_post(
--     url     := v_url,
--     headers := jsonb_build_object('content-type', 'application/json', 'x-audit-key', v_secret),
--     body    := jsonb_build_object('submissionIds', to_jsonb(p_submission_ids)),
--     timeout_milliseconds := 60000
--   ) INTO v_req_id;
--   RETURN v_req_id;
-- END;
-- $function$;
