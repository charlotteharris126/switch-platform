-- Migration 0231 — delete the persistent S4B admin test lead (#725)
-- Date: 2026-07-23
-- Author: Claude (Sasha/platform) with owner sign-off
-- Reason: #725 was a DQ test lead left for Charlotte to view focus_area in
--   /admin/leads. She's seen it; owner asked to delete. DQ, so no children
--   (no enrolment/email/routing/capi rows — verified). Single-row delete.
--   Shipped as a migration (only write path to the main project this session).
-- Impact (§8): removes one flagged test row. No real data touched.

-- UP
DELETE FROM leads.submissions WHERE id = 725;

-- DOWN
-- Irreversible (test-data deletion). No rollback.
