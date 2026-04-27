-- data-ops 002 — seed sheet_id + sheet_webhook_url for pilot providers
-- Date: 2026-04-20
-- Author: Claude (Session 3) with owner review
-- Reason: Session 3 routing-confirm Edge Function reads sheet_webhook_url from crm.providers
--   and POSTs the lead row there (Google Apps Script deployed on each provider's sheet).
--   Columns added by migration 0009; this file populates them for active pilot providers.
-- Related:
--   - platform/supabase/migrations/0009_add_provider_sheet_refs.sql (adds the columns)
--   - platform/apps-scripts/provider-sheet-appender.gs (the script deployed on each sheet)
--   - platform/docs/session-3-scope.md
--
-- Pattern: this is a data seed, not a schema change. Kept in data-ops/ per
-- .claude/rules/data-infrastructure.md §3 (migrations are schema; data lives in data-ops).
-- Re-runnable: UPDATEs are idempotent against a given sheet_id / webhook URL.
--
-- Run after migration 0009 has been applied. One transaction in the Supabase SQL editor.

-- Enterprise Made Simple — active pilot provider, receives funded leads
UPDATE crm.providers
   SET sheet_id          = '1ABX9p_5OQUS3kLD1ztvFYSccozoTOmt7RiiDBg4IOuU',
       sheet_webhook_url = 'https://script.google.com/macros/s/AKfycbw35aTlElUvxdU3zh-EwLeI0M_XUfLKHQoU08xewvz2Xgoz-UCbRa_4k4rE5k2sKT4R-Q/exec'
 WHERE provider_id = 'enterprise-made-simple';

-- Courses Direct — no self-funded leads landed to date (per platform/weekly-notes.md 2026-04-19).
-- Sheet and Apps Script not yet created. Add a follow-up data-ops file when that work happens.
--   UPDATE crm.providers
--      SET sheet_id          = '<courses-direct sheet id>',
--          sheet_webhook_url = '<courses-direct apps script web app url>'
--    WHERE provider_id = 'courses-direct';

-- Verify:
-- SELECT provider_id, sheet_id IS NOT NULL AS has_sheet_id, sheet_webhook_url IS NOT NULL AS has_webhook
--   FROM crm.providers
--  ORDER BY provider_id;
