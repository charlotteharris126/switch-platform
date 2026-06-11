-- Migration 0206 — clear the routine/transient dead_letter backlog (clean slate)
-- Date: 2026-06-11
-- Author: Claude (Sasha session) with owner review
-- Reason: The dead_letter table had accumulated ~114 unresolved rows, 109 of
--   which were routine drift notices, self-healing retries, transient blips, or
--   test artefacts, not real failures. With the new auto-resolve on the Brevo
--   cron and the page/email severity split shipping in the same session, we
--   reset to a clean slate so "anything unresolved here = a real problem"
--   becomes true again (data-infrastructure rule section 10).
-- What this clears (resolves replayed_at = now() on currently-unresolved rows):
--   sheet_drift_detected (~73)  benign sheet-lag; DB is the source of truth and
--     is correct. The daily sheet-drift cron self-cleans and re-detects any
--     genuine drift on its next run.
--   brevo_attribute_reconcile_async_check_result (~15)  Brevo check run logs.
--   edge_function_partial_capture (~4)  abandoned half-filled forms, no lead.
--   edge_function_brevo_upsert (~3)  Brevo sync timeouts, self-healing.
--   edge_function_labs_event (~2)  transient permission blip during the 0184/
--     0185 deploy on 3 Jun; functions_writer inserts fine since (verified via
--     labs.events_analytics, 4 events landed 4-6 Jun).
--   fastrack_form (~1)  a test submission (ref=test, no PII), correctly rejected.
--   netlify_audit (~1)  transient allowlist fetch failure; URL is live (200).
--   brevo_transactional_sms (~1)  SMS not sent, Brevo SMS credits ran out
--     (operational top-up, tracked separately; clearing the notice is safe).
-- Deliberately NOT cleared here: brevo_attribute_drift. Those 15 contacts hold
--   genuinely stale Brevo attributes; they are reconciled by an operator Brevo
--   "Re-sync" (DB -> Brevo), which fixes the data and auto-resolves the rows via
--   the redeployed brevo-attribute-reconcile cron. Hiding them without the
--   re-sync would leave stale values that can render in a marketing broadcast.
-- Impact: read-only consumers see fewer unresolved dead_letter rows. No lead,
--   enrolment, or business row is touched; this only stamps replayed_at on
--   already-handled drift notices.
-- Related: ticket e2b2615f, platform/docs/changelog.md, the same-session
--   page.tsx + drift-digest-daily + brevo-attribute-reconcile changes.

-- UP
UPDATE leads.dead_letter
   SET replayed_at = now()
 WHERE replayed_at IS NULL
   AND source IN (
     'sheet_drift_detected',
     'brevo_attribute_reconcile_async_check_result',
     'edge_function_partial_capture',
     'edge_function_brevo_upsert',
     'edge_function_labs_event',
     'fastrack_form',
     'netlify_audit',
     'brevo_transactional_sms'
   );

-- DOWN
-- No rollback. These rows are routine/transient drift resolutions, not data
-- changes that need reversing; the daily reconcile crons re-detect any genuine
-- drift on their next run if it still exists.
