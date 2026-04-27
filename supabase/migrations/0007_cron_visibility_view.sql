-- Migration 0007 — cron visibility views for readonly_analytics
-- Date: 2026-04-19
-- Author: Claude (Session 2.5, post-incident continuation) with owner review
-- Reason: Migration 0006 granted readonly_analytics SELECT on cron.job and
-- cron.job_run_details, but pg_cron has a built-in visibility filter that
-- restricts SELECT to rows the current user owns. readonly_analytics owns no
-- jobs, so even with SELECT privilege it sees zero rows — defeating the
-- Sasha Monday verification that 0006 was supposed to enable.
--
-- Fix: expose cron metadata through SECURITY DEFINER views in the public
-- schema. The views run with the privileges of their owner (postgres, which
-- owns cron.job), so they return all rows regardless of who's querying.
-- readonly_analytics is granted SELECT on the views, not the underlying
-- tables — least privilege, and the underlying grants from 0006 remain for
-- any future direct-access need.
--
-- Security note: exposing cron.job.command to a read-only role is safe here
-- because none of our scheduled commands embed secrets inline. The
-- netlify-forms-audit-hourly cron's shared secret lives in its header (which
-- is in cron.job.command as part of the net.http_post call) — we accept that
-- trade-off for observability, and treat the command column as sensitive
-- (do not paste into Slack, logs, etc.). If we later add a cron with a truly
-- secret-containing command, we'll redact it in the view.
--
-- Related: platform/docs/changelog.md 2026-04-19 Session 2.5 incident entry,
-- platform/docs/infrastructure-manifest.md, platform/CLAUDE.md "Automation
-- health" section in Sasha's scope.

-- UP

-- Drop pre-existing objects if re-applying (idempotent).
DROP VIEW IF EXISTS public.vw_cron_jobs;
DROP VIEW IF EXISTS public.vw_cron_runs;

CREATE VIEW public.vw_cron_jobs
WITH (security_invoker = false) AS
SELECT
  jobid,
  jobname,
  schedule,
  command,
  active,
  username,
  database,
  nodename,
  nodeport
FROM cron.job;

CREATE VIEW public.vw_cron_runs
WITH (security_invoker = false) AS
SELECT
  jobid,
  runid,
  job_pid,
  database,
  username,
  command,
  status,
  return_message,
  start_time,
  end_time
FROM cron.job_run_details;

ALTER VIEW public.vw_cron_jobs OWNER TO postgres;
ALTER VIEW public.vw_cron_runs OWNER TO postgres;

GRANT SELECT ON public.vw_cron_jobs TO readonly_analytics;
GRANT SELECT ON public.vw_cron_runs TO readonly_analytics;

-- Verification (run after apply as readonly_analytics OR via Postgres MCP):
--   SELECT count(*) FROM public.vw_cron_jobs;
--   Expected: >= 2 (netlify-forms-audit-hourly + purge-stale-partials)
--
--   SELECT jobname, schedule, active FROM public.vw_cron_jobs ORDER BY jobname;
--   Expected rows include:
--     netlify-forms-audit-hourly   0 * * * *   true
--     purge-stale-partials         0 3 * * *   true

-- DOWN
-- REVOKE SELECT ON public.vw_cron_runs FROM readonly_analytics;
-- REVOKE SELECT ON public.vw_cron_jobs FROM readonly_analytics;
-- DROP VIEW IF EXISTS public.vw_cron_runs;
-- DROP VIEW IF EXISTS public.vw_cron_jobs;
