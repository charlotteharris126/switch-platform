-- Migration 0229 — delete the S4B focus_area test leads (#723, #724)
-- Date: 2026-07-23
-- Author: Claude (Sasha/platform) with owner sign-off
-- Reason: cleanup of the two QA test leads that proved the 0227 focus_area wiring
--   end to end this session:
--     #723 — DQ test (no company_name), proved focus_area persists via the live
--            router without routing.
--     #724 — routed test under TEST_MODE ("ZZ TEST - Switchable QA"), proved the
--            routed path + focus_area + the U1 employer Brevo ack send. It routed
--            to riverside-training, so it created a crm.enrolments row and would
--            appear in Riverside's live portal — must be removed so Freya never
--            sees a fake lead and it never pollutes enrolment metrics.
--   No enforced FK on leads.submissions(id), so child rows (email_log, routing_log,
--   enrolments, capi_log) are deleted explicitly to avoid orphans. Shipped as a
--   migration because this automated session has no other write path to the main
--   project. Leaves a numeric gap (723/724) in the submission id sequence, which
--   is expected and harmless.
-- Impact (§8): deletes only the two flagged test rows + their children. No real
--   data touched. crm.billing_events / enrolment_disputes have no rows for these
--   (verified). Owner-directed.

-- UP
BEGIN;
DELETE FROM crm.enrolments   WHERE submission_id IN (723, 724);
DELETE FROM leads.capi_log   WHERE submission_id IN (723, 724);
DELETE FROM crm.email_log    WHERE submission_id IN (723, 724);
DELETE FROM leads.routing_log WHERE submission_id IN (723, 724);
DELETE FROM leads.submissions WHERE id IN (723, 724);
COMMIT;

-- DOWN
-- Irreversible (test-data deletion). No rollback.
