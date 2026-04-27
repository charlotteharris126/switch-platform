-- Migration 0008 — redact command column from public.vw_cron_jobs
-- Date: 2026-04-19
-- Author: Claude (Session 2.5 continuation) with owner review
-- Reason: Migration 0007's header incorrectly stated that scheduled cron
-- commands did not embed secrets inline. Inspection of cron.job.command
-- after migration 0007 showed the `x-audit-key` shared secret is stored
-- plaintext inside the `net.http_post` call for every audit cron. Because
-- vw_cron_jobs exposed the full command column to readonly_analytics,
-- every agent using the MCP could read the shared secret. This migration
-- drops the command column from the view.
--
-- Agents no longer need the command text for governance checks — the
-- jobname, schedule, and active columns are sufficient for confirming
-- "is this scheduled and enabled". If an agent ever needs the command
-- (e.g. for debugging), they should escalate to owner and inspect
-- cron.job directly as postgres, not go through the view.
--
-- Follow-up (ticket): move AUDIT_SHARED_SECRET into vault.secrets so the
-- command itself stops containing plaintext secrets. Done separately.
--
-- Related: platform/docs/changelog.md 2026-04-19 Session 2.5 incident entry,
-- platform/docs/infrastructure-manifest.md, migration 0007.

-- UP

DROP VIEW IF EXISTS public.vw_cron_jobs;

CREATE VIEW public.vw_cron_jobs
WITH (security_invoker = false) AS
SELECT
  jobid,
  jobname,
  schedule,
  active,
  username,
  database,
  nodename,
  nodeport
FROM cron.job;

ALTER VIEW public.vw_cron_jobs OWNER TO postgres;
GRANT SELECT ON public.vw_cron_jobs TO readonly_analytics;

-- DOWN
-- DROP VIEW IF EXISTS public.vw_cron_jobs;
-- (Re-apply migration 0007 to restore the prior view shape — but don't: it exposes secrets.)
