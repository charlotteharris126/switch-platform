-- Migration 0009 — add sheet_id + sheet_webhook_url to crm.providers, seed for EMS + Courses Direct
-- Date: 2026-04-20
-- Author: Claude (Session 3) with owner review
-- Reason: Session 3 automates the manual-sheet-forward step. Each provider has a temporary
--   Google Sheet that the routing-confirm Edge Function appends rows to via a Google Apps
--   Script webhook deployed on the sheet itself (chosen over Google Sheets API to avoid a
--   Google Cloud project for a transitional surface). Sheet IDs stay as human-readable
--   references. Webhook URLs are the machine endpoint. Sheets retire when the platform
--   front-end (Phase 4) is built, and crm.enrolments becomes the source of truth.
-- Related:
--   - platform/docs/session-3-scope.md — approved scope for this migration and build
--   - platform/docs/data-architecture.md — crm.providers schema (must be updated with these columns after apply)
--   - .claude/rules/data-infrastructure.md §3 — migration file rules
--
-- Before running:
--   1. Run this file as one transaction in the Supabase SQL editor.
--   2. After this migration, apply data-ops/002_provider_sheet_info.sql to seed
--      sheet_id and sheet_webhook_url for EMS (and Courses Direct when its sheet exists).
--   3. Verify with the query at the bottom of the file.
--
-- Sheet IDs and Apps Script Web app URLs are not credentials in the secret sense. They
-- are access points gated by share settings (sheet_id) or by shared token verification
-- inside the Apps Script (sheet_webhook_url). They are safe to commit in data-ops/.

-- UP

-- Add the two columns. Nullable: existing rows (EMS + Courses Direct) backfilled by the
-- UPDATE below (EMS) or left NULL (Courses Direct until its sheet is created). NULL on
-- sheet_webhook_url means "no sheet integration configured, skip sheet append for this provider".
ALTER TABLE crm.providers
  ADD COLUMN sheet_id          TEXT,
  ADD COLUMN sheet_webhook_url TEXT;

COMMENT ON COLUMN crm.providers.sheet_id          IS 'Google Sheet spreadsheet ID for the provider''s temporary lead sheet. Human-readable reference; not used by the Edge Function. Retires with platform front-end.';
COMMENT ON COLUMN crm.providers.sheet_webhook_url IS 'Google Apps Script web app URL bound to the provider''s sheet. Edge Function POSTs the lead row here with SHEETS_APPEND_TOKEN in the body. NULL means skip sheet append for this provider. Rotate URL by re-deploying the Apps Script as a new version; log in platform/docs/changelog.md.';

-- Seed values for existing providers live in data-ops/002_provider_sheet_info.sql.
-- This migration is schema-only, consistent with 0001-0008.

-- Sanity check: confirm the new columns exist.
-- SELECT column_name FROM information_schema.columns WHERE table_schema='crm' AND table_name='providers' AND column_name IN ('sheet_id','sheet_webhook_url');

-- DOWN
-- ALTER TABLE crm.providers DROP COLUMN sheet_webhook_url;
-- ALTER TABLE crm.providers DROP COLUMN sheet_id;
