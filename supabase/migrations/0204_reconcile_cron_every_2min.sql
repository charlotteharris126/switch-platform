-- Migration 0204 — speed up the lead-reconcile cron from every 10 min to every 2 min
-- Date: 2026-06-09
-- Author: Claude (Sasha/platform) with owner sign-off (Charlotte, this session)
-- Reason: The Netlify -> netlify-lead-router webhook's known intermittent drop
--   (~3% of leads, documented in 0202) became painful once the Sunderland EMS
--   campaign drove higher lead volume on 8 Jun: dropped leads waited up to 10 min
--   for the backfill, so owner notifications + provider emails arrived badly late
--   and out of order. Tightening the sweep to every 2 min caps the worst-case
--   recovery delay for a dropped lead at ~2-4 min. Paired with the 2-minute grace
--   window added to netlify-leads-reconcile the same session, so the faster sweep
--   does NOT race the healthy (~97%) webhook (which would otherwise multiply the
--   false "back-filled" alerts and risk dropping the re-delivered lead's emails).
--   Root cause of the webhook drop itself is being investigated separately via
--   the lead-router delivery logs; this is the interim mitigation.
-- Impact: one pg_cron schedule change (job 'netlify-leads-reconcile-hourly', now a
--   misnomer). More frequent Netlify API reads — still trivial at pilot volume
--   (per_page=100, ~1 page). No DDL. Idempotency (ON CONFLICT on the Netlify
--   submission id) still prevents any double-route. Reversible.
-- Related: migration 0202 (10-min schedule), netlify-leads-reconcile GRACE_MINUTES=2.

-- UP
DO $$
DECLARE v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'netlify-leads-reconcile-hourly';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(v_jobid, schedule := '*/2 * * * *');
  END IF;
END $$;

-- DOWN
-- DO $$
-- DECLARE v_jobid bigint;
-- BEGIN
--   SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'netlify-leads-reconcile-hourly';
--   IF v_jobid IS NOT NULL THEN PERFORM cron.alter_job(v_jobid, schedule := '*/10 * * * *'); END IF;
-- END $$;
