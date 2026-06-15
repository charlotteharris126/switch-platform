-- Migration 0214 — schedule capi-reconcile-daily
-- Date: 2026-06-15
-- Author: Claude (Sasha session) on Charlotte's direction
-- Reason: Daily monitor for the server-side Meta CAPI path (migration 0213 +
--   the router CAPI sends). Compares, per brand, leads that should have fired
--   CAPI vs successful leads.capi_log rows, and emails the owner on any gap or
--   failed send. Turns a silent CAPI outage into a next-morning alert.
-- Related: platform/docs/capi-server-side-scoping-2026-06-15.md,
--   functions/capi-reconcile-daily, _shared/meta-capi.ts.
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: one pg_cron schedule that POSTs to capi-reconcile-daily daily.
--   2. Readers: the function reads leads.submissions + leads.capi_log (counts).
--   3. Writers: none (read + email only; no DB writes).
--   4. schema_version: not affected.
--   5. Data migration: none.
--   6. Role/policy: function authenticates with x-audit-key (Vault secret),
--      same posture as netlify-leads-reconcile / email-*-cron.
--   7. Rollback: cron.unschedule (DOWN below).
--   8. Sign-off: owner (this session).
-- Note: 08:10 UTC, after the lead-reconcile sweeps, before the working day.

-- UP
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'capi-reconcile-daily') THEN
    PERFORM cron.unschedule('capi-reconcile-daily');
  END IF;
END $$;

SELECT cron.schedule(
  'capi-reconcile-daily',
  '10 8 * * *',
  $cmd$
    SELECT net.http_post(
      url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/capi-reconcile-daily',
      headers := jsonb_build_object(
        'x-audit-key', public.get_shared_secret('AUDIT_SHARED_SECRET'),
        'content-type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cmd$
);

-- DOWN
-- SELECT cron.unschedule('capi-reconcile-daily');
