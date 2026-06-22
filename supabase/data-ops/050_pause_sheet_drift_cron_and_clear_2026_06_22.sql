-- Data-op 050 — pause the sheet-drift reconcile cron and clear its backlog
-- Date: 2026-06-22
-- Author: Claude (Sasha session). Sasha has READ-ONLY DB access — owner applies this.
-- Reason: data-op 049 cleared the sheet_drift_detected backlog, but the daily cron
--   `sheet-drift-reconcile-daily` (jobid 20, 06:00 UTC) re-ran on 2026-06-22 and
--   re-detected the same drift (32 rows), because the sheet still exists and the DB
--   has moved on. We've decided the DB is authoritative (EMS marks outcomes in the
--   portal; the sheet is stale by design) and the sheet is being retired 25 Jun
--   (provider notified). So the drift reconcile has nothing useful left to do — it
--   only generates daily noise. Pause it now; full teardown follows at retirement.
--
-- Reversible: this sets active=false (a pause), not unschedule (a delete). Flip back
--   to true if the sheet ever comes back (it won't — EMS is moving to the portal and
--   no other provider uses a sheet). The companion drift-digest-daily (jobid 24) is
--   left running; it covers the other reconcilers too.
--
-- Confirmed at write time (2026-06-22): 32 open sheet_drift_detected + 1 open
--   fastrack_side_effect (a sheet-append failure from 21 Jun 20:10; same root cause,
--   also dies with the sheet). Both closed below.

-- ── 1. Pause the cron so it stops re-detecting drift each morning ─────────────
UPDATE cron.job SET active = false WHERE jobname = 'sheet-drift-reconcile-daily';

-- ── 2. Close the current open sheet-related rows ─────────────────────────────
UPDATE leads.dead_letter
SET replayed_at = now(),
    error_context = COALESCE(error_context, '') ||
      E'\n[bulk-closed 2026-06-22 data-op 050: sheet-drift cron paused; DB authoritative; sheet retiring 25 Jun]'
WHERE replayed_at IS NULL
  AND source IN ('sheet_drift_detected', 'fastrack_side_effect');

-- Verify after apply:
--   SELECT jobname, active FROM public.vw_cron_jobs WHERE jobname = 'sheet-drift-reconcile-daily';  -- expect active=false
--   SELECT source, count(*) FILTER (WHERE replayed_at IS NULL) AS open
--     FROM leads.dead_letter GROUP BY source ORDER BY open DESC;  -- expect 0 for both sources
--
-- Full teardown at retirement (25 Jun, separate session): unschedule jobid 20
-- permanently, and remove/short-circuit the sheet-append side effect in
-- fastrack-receive so fastrack_side_effect stops firing at source.
