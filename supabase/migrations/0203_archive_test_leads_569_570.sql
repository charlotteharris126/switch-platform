-- Migration 0203 — archive tonight's team-leading test leads (569, 570)
-- Date: 2026-06-08
-- Author: Claude (Sasha/platform) with owner sign-off
-- Reason: 569 + 570 are Charlotte's end-to-end test submissions (icloud +aliases)
--   that routed to EMS during testing. Archive them out of reporting and remove
--   their open enrolments so they don't sit in EMS's portal/pipeline or skew lead
--   numbers. Data fix (not schema); transactional, so a FK block rolls back clean.
-- Impact: 2 submissions archived, 2 enrolments removed. Provider notification
--   emails already sent during the test (EMS aware they were tests).

-- UP
-- Soft-archive only (no deletes). archived_at removes them from reporting and the
-- provider portal's lead views (which filter on the submission's archived_at).
UPDATE leads.submissions SET archived_at = now()
 WHERE id IN (569, 570) AND archived_at IS NULL;

-- DOWN
-- UPDATE leads.submissions SET archived_at = NULL WHERE id IN (569, 570);
