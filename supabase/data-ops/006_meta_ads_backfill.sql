-- data-ops/006 — Meta ads backfill (Session 22)
-- Date: 2026-05-02
-- Author: Claude (Session 22) with owner review
-- Scope: trigger meta-ads-ingest for the date range 2026-04-15 → 2026-05-02
-- so ads_switchable.meta_daily fills with the historical pilot spend.
--
-- Why data-ops and not a migration: this is a one-shot ingest call, no schema
-- change. Daily cron schedule is a separate file (007) once we've verified
-- this run lands rows cleanly.
--
-- Auth: pulled from Vault via public.get_shared_secret('AUDIT_SHARED_SECRET'),
-- the same helper migrations 0019 wired in for the existing crons. No secret
-- ever appears in this iCloud-synced file (per .claude/rules/data-infrastructure.md §5).
--
-- Related:
--   platform/supabase/functions/meta-ads-ingest/index.ts
--   platform/docs/changelog.md — Session 22 entry
--   platform/supabase/migrations/0019_vault_helper_for_shared_secrets.sql
--
-- How to run:
--   1. In the Supabase dashboard → SQL Editor.
--   2. Paste this whole file and run it.
--   3. Wait ~15 seconds for pg_net to complete the HTTP call, then run the
--      verify queries at the bottom.

-- Fire the backfill
SELECT net.http_post(
  url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/meta-ads-ingest',
  headers := jsonb_build_object(
    'x-audit-key', public.get_shared_secret('AUDIT_SHARED_SECRET'),
    'content-type', 'application/json'
  ),
  body := jsonb_build_object(
    'since', '2026-04-15',
    'until', '2026-05-02'
  ),
  timeout_milliseconds := 60000
) AS request_id;

-- ===== After ~15 seconds, run these to verify =====

-- 1. The HTTP response from the function. Expect status_code=200, timed_out=false.
-- SELECT id, status_code, timed_out, error_msg, created,
--        substring(content::text, 1, 500) AS body_preview
--   FROM net._http_response
--  WHERE created > now() - interval '5 minutes'
--  ORDER BY created DESC
--  LIMIT 3;

-- 2. Row count and date coverage in meta_daily.
-- SELECT
--   count(*) AS rows,
--   count(DISTINCT date) AS days_covered,
--   min(date) AS earliest,
--   max(date) AS latest,
--   round(sum(spend)::numeric, 2) AS total_spend_gbp,
--   sum(leads) AS meta_reported_leads
-- FROM ads_switchable.meta_daily
-- WHERE date >= '2026-04-15';

-- 3. Per-day breakdown so you can sanity-check against Ads Manager.
-- SELECT date,
--        round(sum(spend)::numeric, 2) AS spend,
--        sum(leads) AS leads,
--        count(*) AS ads
--   FROM ads_switchable.meta_daily
--  WHERE date >= '2026-04-15'
--  GROUP BY date
--  ORDER BY date;
