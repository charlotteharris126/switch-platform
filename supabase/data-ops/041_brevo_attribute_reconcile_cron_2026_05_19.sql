-- Data-ops 041 — schedule brevo-attribute-reconcile-daily (dry-run + log_drift)
-- Date: 2026-05-19 (Session 54)
-- Author: Claude (Sasha session) with owner sign-off
--
-- Why:
--   Closes the at-a-glance gap on /admin/errors. Sheet ↔ DB + Netlify ↔ DB
--   cards already render a drift pill on page load (their daily/hourly
--   crons write leads.dead_letter rows). DB ↔ Brevo had no scheduled
--   cron — only on-demand "Check drift" — so the card couldn't show
--   aligned/drifted at-a-glance.
--
--   This cron fires the dry-run path daily at 06:15 UTC with
--   `log_drift: true`. When contacts_with_drift > 0 the function writes a
--   single summary row to leads.dead_letter (source='brevo_attribute_drift').
--   Clean runs leave nothing — pill defaults to Aligned in their absence.
--
--   Drift-digest-daily at 06:30 UTC picks up the same row (15 min later)
--   so the morning email also covers Brevo drift now.
--
-- Schedule rationale:
--   - 06:15 UTC: 15 min before drift-digest-daily (06:30 UTC) so today's
--     drift signal is in dead_letter when the digest reads.
--   - 15 min later than sheet-drift-reconcile-daily (06:00 UTC) — both
--     fire well inside the digest window.
--
-- Secret handling: same as data-ops/040 — calls
-- public.get_shared_secret('AUDIT_SHARED_SECRET') at fire time. No plaintext
-- secret in cron.job, no manual substitution needed.
--
-- Timeout: 60000ms. Function walks ~200 Brevo contacts at ~30-60s with the
-- parallelized dry-run path (see brevo-attribute-reconcile/index.ts, 2026-05-19
-- perf fix). 60s leaves comfortable headroom even as audience grows.
--
-- Related:
--   - supabase/functions/brevo-attribute-reconcile/index.ts (target)
--   - data-ops/040 (digest cron, reads the same dead_letter rows)
--   - platform/docs/changelog.md — Session 54 entry
--   - platform/docs/infrastructure-manifest.md — needs the new row added
--
-- How to run: paste and run. No secret substitution.

BEGIN;

SELECT cron.schedule(
  'brevo-attribute-reconcile-daily',
  '15 6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/brevo-attribute-reconcile',
    headers := jsonb_build_object(
      'x-audit-key', public.get_shared_secret('AUDIT_SHARED_SECRET'),
      'content-type', 'application/json'
    ),
    body := jsonb_build_object('apply', false, 'log_drift', true),
    timeout_milliseconds := 60000
  );
  $$
);

COMMIT;

-- Verify:
--   SELECT jobname, schedule, active FROM public.vw_cron_jobs WHERE jobname = 'brevo-attribute-reconcile-daily';
--
-- Smoke test (no secret needed):
--   SELECT net.http_post(
--     url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/brevo-attribute-reconcile',
--     headers := jsonb_build_object(
--       'x-audit-key', public.get_shared_secret('AUDIT_SHARED_SECRET'),
--       'content-type', 'application/json'
--     ),
--     body := jsonb_build_object('apply', false, 'log_drift', true),
--     timeout_milliseconds := 60000
--   );
--   -- Then: SELECT status_code, content::jsonb FROM net._http_response ORDER BY id DESC LIMIT 1;
--   -- Expect status 200 + content { ok: true, mode: 'dry_run', contacts_with_drift: N, ... }
--   -- And if N > 0: SELECT id, error_context FROM leads.dead_letter WHERE source = 'brevo_attribute_drift' ORDER BY id DESC LIMIT 1;
