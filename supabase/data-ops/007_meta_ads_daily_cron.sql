-- data-ops/007 — Meta ads daily ingest cron (Session 22)
-- Date: 2026-05-02
-- Author: Claude (Session 22) with owner review
-- Scope: schedule meta-ads-ingest to run daily at 08:00 UTC (09:00 BST during
-- summer, 08:00 GMT in winter), pulling the last 7 days. The function is
-- idempotent on (date, ad_id) so the rolling window safely overlaps with
-- prior runs and catches any late-attribution backfills Meta makes.
--
-- Why 7 days not 1: Meta's settlement window can backdate conversions for
-- several days. Pulling a rolling week each day means yesterday's spend is
-- final by the time we read it, not still drifting.
--
-- Why 08:00 UTC: matches the existing ops cadence; the netlify-leads-reconcile
-- and netlify-forms-audit crons already run hourly, so an early-morning daily
-- pull aligns with Charlotte's first dashboard read of the day.
--
-- Auth: Vault-backed via public.get_shared_secret('AUDIT_SHARED_SECRET'),
-- same pattern as crons 4 and 5 (per migration 0019).
--
-- Related:
--   platform/supabase/functions/meta-ads-ingest/index.ts
--   platform/supabase/data-ops/006_meta_ads_backfill.sql (the one-shot backfill)
--   platform/docs/changelog.md — Session 22 entry
--   platform/docs/infrastructure-manifest.md — add row under Cron Jobs
--
-- How to run: paste this whole file into the Supabase SQL editor and run.

SELECT cron.schedule(
  'meta-ads-ingest-daily',
  '0 8 * * *',
  $$
  SELECT net.http_post(
    url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/meta-ads-ingest',
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
--  WHERE jobname = 'meta-ads-ingest-daily';
-- Expect: one row, active=true, schedule='0 8 * * *'.
