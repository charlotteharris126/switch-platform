-- Migration 0115 — schedule sheet-drift-reconcile-daily
-- Date: 2026-05-11
-- Author: Claude (platform Session 40) with owner sign-off
-- Reason: Proactive drift detection counterpart to the on-demand
--   `republish-provider-sheet` tool shipped in Session 39. The new Edge
--   Function `sheet-drift-reconcile-daily` POSTs the appender's new
--   `read_all_status` mode against every active provider's sheet, compares
--   each row against `crm.enrolments` + `leads.submissions.fastracked_at`,
--   and logs disagreements to `leads.dead_letter` for the operator to
--   replay via the republish panel. Drift detection had been operator-
--   discretion since the republish tool shipped; this closes the gap.
--
--   06:00 UTC chosen because:
--     - Well after the previous evening's last sheet activity (provider
--       working hours end ~17:00-18:00 UTC) so steady state is settled.
--     - Before the 08:00 UTC meta-ads cron + 09:00 UTC stalled-email
--       cron — leaves Charlotte's morning summary clean of cross-noise.
--     - Before the 06:30 UTC sheet-side editing window starts on a
--       typical working day.
--
--   timeout_milliseconds is 120s (twice the typical cron) because each
--   provider sheet round-trip is ~250-500ms × current 3 providers = ~2s
--   worst case, but a 100-lead provider sheet under cold-start adds
--   another ~15s. Headroom for growth.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: pg_cron schedule that POSTs to sheet-drift-reconcile-daily
--      daily. No table change.
--   2. Readers: function reads crm.providers (active sheets), leads.submissions
--      + crm.enrolments (DB lead state), leads.dead_letter (prior unresolved
--      drift for dedup).
--   3. Writers: function INSERTs into leads.dead_letter via functions_writer
--      (sources 'sheet_drift_detected' + 'sheet_drift_provider_skipped').
--      No other writes. Read-only on the provider sheets themselves (the
--      new `read_all_status` appender mode does not touch cells).
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role/policy: function authenticates with x-audit-key (vault-stored
--      AUDIT_SHARED_SECRET). Dead-letter inserts use functions_writer via
--      `SET LOCAL ROLE` (existing grant from migration 0079). No new RLS
--      policy.
--   7. Rollback: cron.unschedule (in DOWN). Edge Function stays deployed
--      but stops being triggered.
--   8. Sign-off: owner (this session).
--
-- Pre-cutover requirement: every active provider sheet must be redeployed
-- with the 2026-05-11 Apps Script (adds `read_all_status` mode). Until a
-- sheet is redeployed, the cron logs one `sheet_drift_provider_skipped`
-- dead_letter row per day per such sheet ("unknown mode: read_all_status")
-- and skips comparison for that provider.
--
-- Related:
--   platform/supabase/functions/sheet-drift-reconcile-daily/index.ts
--   platform/supabase/functions/republish-provider-sheet/index.ts
--   platform/apps-scripts/provider-sheet-appender-v2.gs (read_all_status mode)
--   platform/supabase/migrations/0076_email_stalled_cron.sql (pattern)

-- UP

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sheet-drift-reconcile-daily') THEN
    PERFORM cron.unschedule('sheet-drift-reconcile-daily');
  END IF;
END $$;

SELECT cron.schedule(
  'sheet-drift-reconcile-daily',
  '0 6 * * *',
  $cmd$
    SELECT net.http_post(
      url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/sheet-drift-reconcile-daily',
      headers := jsonb_build_object(
        'x-audit-key', public.get_shared_secret('AUDIT_SHARED_SECRET'),
        'content-type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cmd$
);

-- DOWN
-- SELECT cron.unschedule('sheet-drift-reconcile-daily');
