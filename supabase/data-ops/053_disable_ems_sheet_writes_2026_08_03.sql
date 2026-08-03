-- Data-ops 053 — disable DB->sheet writes for EMS (portal cutover)
-- Date:   2026-08-03
-- Owner:  Charlotte (session), executed by Claude (Sasha/platform)
-- Reason:
--   EMS have fully moved to the provider portal: 6 portal users, 5 logged in,
--   last login 2026-08-03; their Google Sheet had no EMS-side activity since
--   2026-07-15. Charlotte removed EMS's Google Drive access to the sheet on
--   2026-08-03. With no one reading the sheet, the DB->sheet append (via
--   netlify-lead-router + fastrack-receive, keyed on crm.providers.sheet_webhook_url)
--   is now writing to a dead file. Null the webhook so we stop.
--
--   Scope: EMS only. WYK Digital and Courses Direct keep their sheet_webhook_url
--   and stay on the sheet route. The shared reconcile-sheet-to-db daily cron
--   (0115) stays scheduled for them; it simply has nothing to reconcile for EMS
--   now (no webhook = no appends, and no EMS edits since the access removal).
--
--   sheet_id is left in place as a record of which sheet EMS used; only the
--   write webhook is cleared.
--
-- Impact (§8): single-row UPDATE on crm.providers, EMS only. Producers affected:
--   netlify-lead-router + fastrack-receive skip the sheet append when
--   sheet_webhook_url IS NULL (existing guard: `if (provider?.sheet_webhook_url)`).
--   No consumer of leads.submissions / crm.enrolments changes. Portal is
--   unaffected (reads the DB directly). Fully reversible via DOWN.
-- Rollback: restore the prior webhook URL (see DOWN).

BEGIN;

UPDATE crm.providers
   SET sheet_webhook_url = NULL
 WHERE provider_id = 'enterprise-made-simple';

COMMIT;

-- DOWN
-- UPDATE crm.providers
--    SET sheet_webhook_url = 'https://script.google.com/macros/s/AKfycbw35aTlElUvxdU3zh-EwLeI0M_XUfLKHQoU08xewvz2Xgoz-UCbRa_4k4rE5k2sKT4R-Q/exec'
--  WHERE provider_id = 'enterprise-made-simple';
