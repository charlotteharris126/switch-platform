-- Data-ops 040 — schedule drift-digest-daily, unschedule dead-letter-alert-hourly
-- Date: 2026-05-19 (Session 54)
-- Author: Claude (Sasha session) with owner sign-off
--
-- Why:
--   Replaces the hourly dead-letter alert + the daily sheet-drift email with
--   ONE 06:30 UTC digest from drift-digest-daily. Same signals, one inbox
--   channel. Charlotte's preference recorded 2026-05-19 in S53 handoff +
--   confirmed 2026-05-19 Session 54: at current volumes a 24h delay on
--   transient failures is acceptable; the noise reduction is worth more
--   than per-hour granularity.
--
-- Why data-ops and not a migration:
--   cron.schedule + cron.unschedule are stored-procedure calls on the
--   `cron` schema, not schema mutations. Matches data-ops/004 (the
--   netlify-leads-reconcile cron) and data-ops/007 (meta ads daily cron).
--
-- Related:
--   - platform/supabase/functions/drift-digest-daily/index.ts (target)
--   - platform/supabase/functions/dead-letter-alert-cron/index.ts (function
--     stays deployed for ad-hoc invocation; schedule is what we drop)
--   - platform/supabase/functions/sheet-drift-reconcile-daily/index.ts (its
--     email send is suppressed in code in this session; the cron itself
--     keeps running so dead_letter writes continue feeding the digest)
--   - platform/docs/changelog.md — Session 54 entry
--   - platform/docs/infrastructure-manifest.md — cron jobs table needs the
--     drift-digest-daily row added and dead-letter-alert-hourly removed
--
-- How to run:
--   1. Open this file in the Supabase SQL editor.
--   2. Paste and run the whole file. No substitutions needed — the cron body
--      calls public.get_shared_secret('AUDIT_SHARED_SECRET') at execution
--      time, so the live vault value is fetched on every fire. Rotating the
--      secret never requires re-scheduling.
--   3. Verify with the SELECTs at the bottom.
--   4. (Optional) Smoke-test the function manually with the curl block at
--      the bottom of this file before the first scheduled fire.
--
-- Rollback:
--   - Re-schedule dead-letter-alert-hourly with the same body the original
--     data-ops file used (see infrastructure-manifest.md for the canonical
--     definition).
--   - Unschedule drift-digest-daily via SELECT cron.unschedule('drift-digest-daily');

BEGIN;

-- 1. Schedule drift-digest-daily at 06:30 UTC.
--
-- 06:30 UTC = ~07:30 UK (BST). Just before Charlotte's typical day starts.
-- Window inside the function is 25h to overlap the cron boundary by 30 min,
-- so a row landing right at 06:30 yesterday still appears once in today's
-- digest if it wasn't replayed.
--
-- Timeout: 10000ms. Function does one SELECT on leads.dead_letter + one
-- count + one Brevo transactional send. Pilot volume keeps this well under
-- a second; 10s is generous headroom.
--
-- Secret handling: the body calls public.get_shared_secret(...) at execution
-- time rather than baking the secret into the scheduled command. Avoids
-- plaintext secrets in cron.job and means secret rotation propagates
-- automatically. The function is SECURITY DEFINER from migration 0019;
-- pg_cron's executing role can call it.
SELECT cron.schedule(
  'drift-digest-daily',
  '30 6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/drift-digest-daily',
    headers := jsonb_build_object(
      'x-audit-key', public.get_shared_secret('AUDIT_SHARED_SECRET'),
      'content-type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);

-- 2. Unschedule dead-letter-alert-hourly. The function stays deployed (it
-- can still be invoked manually for ad-hoc triage) but the cron stops
-- firing — the digest now covers the same signal once a day.
SELECT cron.unschedule('dead-letter-alert-hourly');

COMMIT;

-- Verify:
--   New schedule present:
--     SELECT jobname, schedule, active FROM public.vw_cron_jobs WHERE jobname = 'drift-digest-daily';
--   Old schedule gone:
--     SELECT jobname FROM public.vw_cron_jobs WHERE jobname = 'dead-letter-alert-hourly';
--     -- Expected: zero rows.
--   Smoke test (no secret needed; the public.get_shared_secret call inside
--   the cron body fetches it from the vault at execution time):
--     SELECT net.http_post(
--       url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/drift-digest-daily',
--       headers := jsonb_build_object(
--         'x-audit-key', public.get_shared_secret('AUDIT_SHARED_SECRET'),
--         'content-type', 'application/json'
--       ),
--       body := '{}'::jsonb,
--       timeout_milliseconds := 10000
--     );
--     -- Expected: a row with status_code 200, content like
--     -- { ok: true, candidates: N, sent: 0|1, ... }.
