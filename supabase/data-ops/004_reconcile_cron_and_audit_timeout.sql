-- data-ops/004 — Session 3.3 cron setup
-- Date: 2026-04-21
-- Author: Claude (Session 3.3) with owner review
-- Scope:
--   1. Schedule netlify-leads-reconcile-hourly (the new lead-loss defence).
--   2. Fix the existing netlify-forms-audit-hourly cron whose pg_net HTTP
--      timeout was 1000ms — far too short for the audit function to actually
--      respond, which left the audit effectively blind from at least
--      2026-04-21 13:00 UTC through the Session 3.3 rescue at ~16:00 UTC.
--
-- Why data-ops and not a migration:
--   cron.schedule + cron.alter_job call stored procedures in the `cron`
--   schema rather than changing table structure. They belong alongside the
--   rest of the data-ops scripts (seeds, backfills) that are runtime
--   procedures against the database.
--
-- Related:
--   - platform/docs/changelog.md — 2026-04-21 Session 3.3 entry (impact assessment)
--   - platform/docs/infrastructure-manifest.md — cron jobs table (update after apply)
--   - platform/supabase/functions/netlify-leads-reconcile/index.ts — the target
--   - platform/docs/secrets-rotation.md — AUDIT_SHARED_SECRET tracked here
--
-- How to run:
--   1. Copy this file into the Supabase SQL editor.
--   2. Replace the THREE <REPLACE_WITH_AUDIT_SHARED_SECRET> placeholders below
--      with the actual AUDIT_SHARED_SECRET value (from Supabase dashboard →
--      Edge Functions → Manage secrets). Same value that's in the existing
--      netlify-forms-audit-hourly cron header.
--   3. Run the whole file.
--   4. Verify with the queries at the bottom.
--
-- After running, the manifest and changelog updates:
--   - infrastructure-manifest.md: add a row under Cron Jobs for
--     netlify-leads-reconcile-hourly (critical=yes, schedule '30 * * * *').
--   - infrastructure-manifest.md: bump the audit-hourly row's Last verified date.
--   - changelog.md: reference data-ops/004 under the Session 3.3 entry.

BEGIN;

-- 1. Schedule netlify-leads-reconcile-hourly
--
-- Schedule: 30 past every hour. Deliberately offset from the audit cron (which
-- runs on the hour) so the two don't collide on pg_net worker capacity.
-- Timeout: 10000ms. The reconcile function does a Netlify API call + up to
-- a few INSERTs + an email. 10s is ample for pilot volume and leaves headroom
-- for growth.
SELECT cron.schedule(
  'netlify-leads-reconcile-hourly',
  '30 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-leads-reconcile',
    headers := jsonb_build_object(
      'x-audit-key', '<REPLACE_WITH_AUDIT_SHARED_SECRET>',
      'content-type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);

-- 2. Fix the existing audit cron's HTTP timeout.
--
-- The existing netlify-forms-audit-hourly was set up via the Supabase dashboard
-- UI (Session 2.5 reset), which defaulted to a 1000ms HTTP timeout. The audit
-- function itself runs fine within its Edge Function budget, but the cron's
-- 1s limit means every pg_net call was aborting before the response returned,
-- and we were silently losing audit observability. Replace with an equivalent
-- cron under the same name but a 10s timeout.
SELECT cron.unschedule('netlify-forms-audit-hourly');

SELECT cron.schedule(
  'netlify-forms-audit-hourly',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-forms-audit',
    headers := jsonb_build_object(
      'x-audit-key', '<REPLACE_WITH_AUDIT_SHARED_SECRET>',
      'content-type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);

COMMIT;

-- Verify
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname IN ('netlify-leads-reconcile-hourly','netlify-forms-audit-hourly') ORDER BY jobname;
-- Expect: both rows, both active=true.
--
-- After the next top-of-hour and half-past-hour runs, verify the pg_net
-- responses are not timing out any more:
-- SELECT id, status_code, timed_out, error_msg, created
--   FROM net._http_response
--  WHERE created > now() - interval '3 hours'
--  ORDER BY created DESC LIMIT 6;
-- Expect: status_code populated (likely 200), timed_out=false.
