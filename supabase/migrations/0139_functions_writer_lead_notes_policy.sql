-- Migration 0139 — add functions_writer RLS policy on crm.lead_notes
-- Date:   2026-05-13
-- Author: Claude (Sasha) with owner review
-- Reason:
--   `fastrack-receive` Edge Function uses `SET LOCAL ROLE functions_writer`
--   and runs two statements in one transaction when fastrack returns
--   l3_mismatch_self_reported or cohort_decline:
--     1) UPDATE crm.enrolments SET status='lost', lost_reason=...
--     2) INSERT INTO crm.lead_notes (author_role='system', ...)
--
--   crm.enrolments has `n8n_write_enrolments` (FOR ALL TO functions_writer
--   USING(true) WITH CHECK(true)) so the UPDATE is fine. crm.lead_notes
--   only has `functions_all_lead_notes` targeting `service_role` — no
--   policy permits functions_writer. The INSERT fails with code 42501
--   ("new row violates row-level security policy"), the transaction rolls
--   back, and the UPDATE on enrolments is reverted.
--
--   Observed in production today: Emma Newton (submission 416) reported
--   l3_mismatch on fastrack at 2026-05-13T06:33:02Z. dead_letter row
--   captured the 42501; enrolment 536 stayed `status='open'` because the
--   transaction rolled back. Pre-regression, Aaron Ryan (submission 322,
--   2026-05-07) auto-flipped cleanly — but his lead_notes record is
--   empty, which means the INSERT block was added to fastrack-receive
--   after his flip. Every l3_mismatch / cohort_decline since has silently
--   failed.
--
--   Fix: mirror the `n8n_write_enrolments` pattern on crm.lead_notes.
--   functions_writer gets ALL access. Other roles' policies are
--   unchanged (admin via authenticated, provider read/write scoped via
--   provider_user_provider_id(), readonly_analytics SELECT, service_role
--   ALL). Adds a defensive GRANT alongside (per memory:
--   "RLS policy targeting a role needs a table-level GRANT for that role
--   too" — bit Session 38 and 2026-05-11 on crm.lead_notes specifically).
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Adds RLS policy + GRANT on crm.lead_notes for functions_writer.
--   2. Reads: no new readers; functions_writer already has SELECT via
--      schema-level / default privileges. ALL policy includes SELECT but
--      doesn't change the row set returned to other readers.
--   3. Writes: unblocks the fastrack-receive auto-DQ INSERT. No other
--      function path is altered.
--   4. schema_version: no bump.
--   5. Data migration: separate replay file for Emma Newton — see
--      `platform/supabase/data-ops/028_replay_emma_newton_l3_mismatch_2026_05_13.sql`.
--   6. RLS coverage: yes, this IS the policy fix.
--   7. Rollback: DROP POLICY + REVOKE in DOWN.
--   8. Sign-off: owner.

-- UP
GRANT SELECT, INSERT, UPDATE, DELETE ON crm.lead_notes TO functions_writer;

CREATE POLICY n8n_write_lead_notes ON crm.lead_notes
  FOR ALL
  TO functions_writer
  USING (true)
  WITH CHECK (true);

-- DOWN
-- DROP POLICY IF EXISTS n8n_write_lead_notes ON crm.lead_notes;
-- REVOKE SELECT, INSERT, UPDATE, DELETE ON crm.lead_notes FROM functions_writer;
