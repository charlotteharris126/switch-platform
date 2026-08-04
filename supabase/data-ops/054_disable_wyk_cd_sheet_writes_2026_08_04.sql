-- Data-ops 054 — null sheet_webhook_url for WYK Digital + Courses Direct
-- Date:   2026-08-04
-- Owner:  Charlotte (session), executed by Claude (Sasha/platform)
-- Reason:
--   Completes the sheet retirement started with EMS (data-op 053). WYK Digital
--   and Courses Direct are both active=false (dormant: last routed 2026-04-23
--   and 2026-05-17), so no leads flow to them and their webhooks never fire.
--   Owner confirmed 2026-08-04 that when either re-engages they onboard to the
--   PORTAL, not sheets. Nulling their webhooks now means NO provider writes to a
--   Google Sheet anymore. Zero live impact (dormant providers). sheet_id kept as
--   a record. The null-webhook path is a clean skip since S87's route-lead fix.
-- Impact (§8): two-row UPDATE on crm.providers. No active consumer. Portal
--   unaffected. Fully reversible via DOWN (restore the two URLs from a backup /
--   the providers table history if ever needed).
-- Note: after this, the sheet code paths (route-lead appendToProviderSheet,
--   employer-lead-core, reconcile-sheet-to-db EF, sheet-edit-mirror EF,
--   sheet-drift-reconcile-daily cron [already disabled], /admin/sheet-activity
--   page, the /admin/errors sheet panel, and the crm.providers.sheet_* columns)
--   all sit dormant with no provider using them. Removing that code + columns is
--   deferred housekeeping (no live impact).

BEGIN;
UPDATE crm.providers SET sheet_webhook_url = NULL
 WHERE provider_id IN ('wyk-digital', 'courses-direct');
COMMIT;

-- DOWN
-- Restore each provider's prior Apps Script /exec URL from backup if a sheet
-- route is ever revived (not expected — future providers use the portal).
