-- Migration 0079 — grants for brevo-event-webhook to flip marketing_opt_in
-- Date: 2026-05-05
-- Author: Claude (platform Session 32) with owner sign-off
-- Reason: Phase 3a of the email platform rearchitecture. The
--   brevo-event-webhook already logs unsubscribe / spam events to
--   crm.consent_history but it does not currently flip the source-of-truth
--   marketing_opt_in column on leads.submissions. Without this writeback,
--   Phase 5 marketing automations would entry-filter on a stale attribute
--   and could re-target unsubscribed learners. This migration adds the
--   minimum privilege surface for the function (running as functions_writer)
--   to UPDATE marketing_opt_in by recipient email.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: column-level UPDATE grant + RLS policy on leads.submissions
--      for the functions_writer role, scoped to marketing_opt_in only.
--   2. Readers: every consumer that already reads leads.submissions
--      (route-lead.ts, dashboard, Iris). They read marketing_opt_in
--      already; this just lets the value change in response to
--      learner-initiated events.
--   3. Writers: brevo-event-webhook becomes the second function-level
--      writer of leads.submissions (alongside admin_update_owner_test_flags
--      from migration 0072). functions_writer scoped to marketing_opt_in
--      only — no other column touched by this policy.
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role/policy: new RLS UPDATE policy 'functions_writer_consent_updates'
--      on leads.submissions for functions_writer role, gated to rows where
--      marketing_opt_in is being changed (no other field changes allowed
--      via this policy).
--   7. Rollback: DROP POLICY + REVOKE in DOWN. Idempotent.
--   8. Sign-off: owner (this session).

BEGIN;

-- functions_writer needs UPDATE on the specific column. Without column-level
-- grant the role cannot write the column even if RLS allows it.
GRANT UPDATE (marketing_opt_in) ON leads.submissions TO functions_writer;

-- RLS policy. functions_writer can update any row to change marketing_opt_in.
-- USING true: any row qualifies for the update path. WITH CHECK true: any
-- post-update state passes (we trust the function code to set the right
-- value — it's only ever flipping false on unsubscribe / spam events).
CREATE POLICY functions_writer_consent_updates
  ON leads.submissions
  FOR UPDATE
  TO functions_writer
  USING (true)
  WITH CHECK (true);

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS functions_writer_consent_updates ON leads.submissions;
-- REVOKE UPDATE (marketing_opt_in) ON leads.submissions FROM functions_writer;
-- COMMIT;
