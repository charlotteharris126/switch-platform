-- Migration 0202 — speed up the lead-reconcile cron from hourly to every 10 min
-- Date: 2026-06-08
-- Author: Claude (Sasha/platform) with owner sign-off
-- Reason: the Netlify -> netlify-lead-router webhook intermittently lags or drops
--   (~3% of leads over 90 days; 0 permanently lost, all caught by the backfill).
--   netlify-leads-reconcile now RE-DELIVERS missed leads through the live router
--   (insert + route + provider email/SMS), so a dropped lead is fully recovered
--   automatically. Running it every 10 min (was hourly) caps the worst-case
--   recovery delay for a dropped lead at ~10 min instead of ~60. Idempotency
--   (ON CONFLICT on the Netlify submission id) prevents any double-route if the
--   webhook later catches up. Job name kept (now a slight misnomer); schedule only.
-- Impact: one pg_cron schedule change (job 'netlify-leads-reconcile-hourly').
--   More frequent Netlify API reads (still small at pilot volume). No DDL.
--   Rollback: set schedule back to '30 * * * *'.

-- UP
DO $$
DECLARE v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'netlify-leads-reconcile-hourly';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(v_jobid, schedule := '*/10 * * * *');
  END IF;
END $$;

-- DOWN
-- DO $$
-- DECLARE v_jobid bigint;
-- BEGIN
--   SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'netlify-leads-reconcile-hourly';
--   IF v_jobid IS NOT NULL THEN PERFORM cron.alter_job(v_jobid, schedule := '30 * * * *'); END IF;
-- END $$;
