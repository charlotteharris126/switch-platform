-- Migration 0232 — delete the Netlify focus_area field-detection test leads (#727, #728)
-- Date: 2026-07-25
-- Author: Claude (Sasha/platform) with owner sign-off
-- Reason: two QA POSTs used to diagnose + verify the Netlify focus_area field-drop
--   (#727 pre-fix: Netlify stripped focus_area; #728 post-redeploy: focus_area
--   captured, fix confirmed). Both routed to riverside-training under TEST_MODE
--   (provider notify redirected off Freya), so each created a crm.enrolments row
--   and would appear in Riverside's portal / enrolment metrics. Remove them and
--   their children. No enforced FK on leads.submissions(id), so children deleted
--   explicitly. Real lead #726 (Black Meteor) is untouched.
-- Impact (§8): deletes only the two flagged test rows + children. No real data.

-- UP
BEGIN;
DELETE FROM crm.enrolments   WHERE submission_id IN (727, 728);
DELETE FROM leads.capi_log   WHERE submission_id IN (727, 728);
DELETE FROM crm.email_log    WHERE submission_id IN (727, 728);
DELETE FROM leads.routing_log WHERE submission_id IN (727, 728);
DELETE FROM leads.submissions WHERE id IN (727, 728);
COMMIT;

-- DOWN
-- Irreversible (test-data deletion). No rollback.
