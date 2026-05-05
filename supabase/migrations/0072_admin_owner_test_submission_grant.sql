-- Migration 0072 — admin column-level UPDATE on leads.submissions for owner-test tagging
-- Date: 2026-05-05
-- Author: Claude (session) with owner review
-- Reason: Today there's no UI surface for tagging a lead as an owner test
--   submission after it's been ingested. Charlotte has had to drop into
--   the SQL editor twice now (sessions today: leads #277 and #284). This
--   migration grants the minimum privileges needed for a future admin
--   server action to set is_dq=true, dq_reason='owner_test_submission',
--   archived_at=now() (and the inverse to undo) on a single submission.
--
-- Pattern mirrors migration 0051 (admin_update_dead_letter): column-level
-- GRANT + RLS UPDATE policy gated on admin.is_admin().
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: GRANT UPDATE on three columns + new RLS UPDATE policy.
--   2. Readers affected: none.
--   3. Writers affected: a future markOwnerTestSubmission server action
--      (this session) is the only intended caller. n8n_writer's existing
--      FOR ALL policy on leads.submissions is untouched.
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. New role/policy: yes — admin_update_owner_test_flags policy.
--   7. Rollback: drop policy + revoke in DOWN.
--   8. Sign-off: owner (this session).

BEGIN;

GRANT UPDATE (is_dq, dq_reason, archived_at) ON leads.submissions TO authenticated;

CREATE POLICY admin_update_owner_test_flags
  ON leads.submissions
  FOR UPDATE
  TO authenticated
  USING (admin.is_admin())
  WITH CHECK (admin.is_admin());

COMMIT;

-- DOWN
-- BEGIN;
-- DROP POLICY IF EXISTS admin_update_owner_test_flags ON leads.submissions;
-- REVOKE UPDATE (is_dq, dq_reason, archived_at) ON leads.submissions FROM authenticated;
-- COMMIT;
