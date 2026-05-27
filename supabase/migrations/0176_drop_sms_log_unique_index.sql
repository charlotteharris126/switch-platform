-- Migration 0176 — drop sms_log_submission_type_uniq, replace with plain index
-- Date: 2026-05-27
-- Author: Claude (Sasha, platform session) with owner sign-off
-- Reason:
--   The partial unique index sms_log_submission_type_uniq enforces "only one
--   healthy row per (submission_id, comm_type) ever":
--
--     CREATE UNIQUE INDEX sms_log_submission_type_uniq
--       ON crm.sms_log (submission_id, comm_type)
--       WHERE status IN ('queued','sent','delivered');
--
--   This matched the original SMS utility design (once-ever per learner per
--   comm_type, no force-resend). Migration 0174 + the 24h cooldown plumbed
--   through fireChaserSms / sendSms changed that: the bulk admin path allows
--   re-fires after 24 hours so Charlotte can re-push a learner whose SMS is
--   more than a day old. The unique index doesn't know about the time
--   window — it rejects any second healthy row, even if the first is 5 days
--   stale. Observed 2026-05-27 ~21:18 UTC: batch of 8 EMS leads with
--   5-day-old successful SMSs all returned 500 with
--   "duplicate key value violates unique constraint sms_log_submission_type_uniq".
--   No new sms_log rows written; UI stayed pinned at the 5-day-old timestamp.
--
--   Fix: drop the unique constraint. Dedup is enforced at the application
--   layer in two places:
--     1. crm.fire_sms_chaser_bulk RPC checks for any healthy row within
--        cooldown window (24h for bulk, no window for auto-fire) before
--        firing the EF — produces accurate per-id skip reasons for the
--        admin toast.
--     2. _shared/brevo.ts sendSms() runs the same SELECT idempotency check
--        with optional cooldownHours, defaulting to once-ever for the
--        auto-fire path (preserves the original semantic for the
--        attempt_1_no_answer trigger).
--     Race window between SELECT and INSERT is small (single EF
--     invocation, no parallel batch fan-out per submission). Worst case:
--     two healthy rows briefly co-exist. Acceptable trade-off; the
--     once-ever invariant is no longer the right contract.
--
--   Replaced with a plain (non-unique) btree on (submission_id, comm_type)
--   so the sendSms idempotency SELECT keeps its index-only scan.
--
-- Related:
--   crm/fire_sms_chaser_bulk migration 0174
--   _shared/brevo.ts sendSms() cooldownHours
--   _shared/sms-utility.ts fireChaserSms()
--   sms-utility-design.md (Wren, 2026-05-21) — original once-ever spec
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: drop unique index, recreate as non-unique. No DDL on data.
--   2. Readers: sendSms idempotency check (uses the same column pair).
--      Replacement index covers it.
--   3. Writers: sendSms inserts; previously blocked on the unique
--      constraint, now relies on its own SELECT pre-check.
--   4. Schema_version: no contract bumped.
--   5. Data migration: none.
--   6. New role / policy: none.
--   7. Rollback: recreate the unique index in DOWN block. Note: rollback
--      will FAIL if any submission has two healthy rows by the time it
--      runs — would need a clean-up pass first.
--   8. Sign-off: owner 2026-05-27.

BEGIN;

DROP INDEX IF EXISTS crm.sms_log_submission_type_uniq;

CREATE INDEX IF NOT EXISTS sms_log_submission_comm_type_idx
  ON crm.sms_log (submission_id, comm_type);

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP INDEX IF EXISTS crm.sms_log_submission_comm_type_idx;
-- CREATE UNIQUE INDEX sms_log_submission_type_uniq
--   ON crm.sms_log (submission_id, comm_type)
--   WHERE status IN ('queued','sent','delivered');
-- COMMIT;
