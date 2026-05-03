-- data-ops/012 — iris-daily-flags daily cron (Iris stage 2)
-- Date: 2026-05-03
-- Author: Claude (Sasha session) with owner review
-- Scope: schedule iris-daily-flags to run daily at 08:30 UTC, 30 min after
-- meta-ads-ingest's 08:00 UTC daily pull. The buffer gives the ingest time
-- to land yesterday's settled spend before flag computation reads it.
--
-- The function computes four checks per
-- switchable/ads/docs/iris-automation-spec.md (P1.2 fatigue, P2.1 daily
-- health, P2.2 CPL anomaly, P2.3 pixel/CAPI drift) and writes to
-- ads_switchable.iris_flags. Idempotent within the day via the 7-day
-- suppression rule.
--
-- Auth: Vault-backed via public.get_shared_secret('AUDIT_SHARED_SECRET'),
-- same pattern as cron 007 (meta-ads-ingest) per migration 0019.
--
-- Related:
--   platform/supabase/functions/iris-daily-flags/index.ts
--   platform/supabase/migrations/0056_iris_flags_foundation.sql (table)
--   platform/supabase/migrations/0057_v_ad_to_routed.sql (view)
--   platform/supabase/migrations/0058_v_ad_baselines.sql (view)
--   switchable/ads/docs/iris-automation-spec.md (threshold spec)
--   platform/docs/changelog.md — Iris stage 2 entry
--   platform/docs/infrastructure-manifest.md — add row under Cron Jobs
--
-- How to run: paste this whole file into the Supabase SQL editor and run.
-- Apply ONLY after the iris-daily-flags Edge Function has been deployed.

SELECT cron.schedule(
  'iris-daily-flags',
  '30 8 * * *',
  $$
  SELECT net.http_post(
    url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/iris-daily-flags',
    headers := jsonb_build_object(
      'x-audit-key', public.get_shared_secret('AUDIT_SHARED_SECRET'),
      'content-type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- Verify
-- SELECT jobname, schedule, active
--   FROM cron.job
--  WHERE jobname = 'iris-daily-flags';
-- Expect: one row, active=true, schedule='30 8 * * *'.
