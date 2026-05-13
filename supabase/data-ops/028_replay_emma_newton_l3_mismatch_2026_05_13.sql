-- Data-ops 028 — replay Emma Newton's l3_mismatch_self_reported auto-DQ
-- Date:   2026-05-13
-- Owner:  Charlotte
-- Reason:
--   Submission 416 (Emma Newton, EMS, counselling-skills-tees-valley)
--   reported `l3_reconfirmed=true` on fastrack at 2026-05-13T06:33:02Z,
--   contradicting her form answer of `prior_level_3_or_higher=false`.
--   `leads.fastrack_submissions` captured the mismatch
--   (`l3_mismatch_flag=true`). fastrack-receive's auto-DQ branch fired
--   but failed RLS on the lead_notes INSERT (code 42501), rolling back
--   the transaction. Enrolment 536 stayed `open`; provider sheet still
--   shows her as Open.
--
--   Migration 0139 fixes the RLS gap so future cases auto-DQ cleanly.
--   This script replays Emma's flip now so she isn't stuck in
--   open-but-actually-DQ limbo.
--
--   Side effects on Andy's EMS sheet: this script ONLY touches DB. After
--   running, Charlotte updates Andy's sheet manually: Emma's row Status
--   column → Lost. (Sheet-edit-mirror cron won't propagate this direction
--   automatically; it picks up sheet → DB updates, not the reverse.)
--
-- Pre-condition: migration 0139 applied (otherwise the lead_notes INSERT
-- will fail with the same RLS error this script is trying to recover from).

BEGIN;

-- 1. Flip the enrolment row.
UPDATE crm.enrolments
   SET status            = 'lost',
       lost_reason       = 'l3_mismatch_self_reported',
       status_updated_at = now(),
       updated_at        = now()
 WHERE submission_id = 416
   AND provider_id = 'enterprise-made-simple'
   AND status = 'open';

-- 2. Insert the system note (now that 0139 unblocked functions_writer; this
--    script runs as postgres so RLS bypasses anyway, but the row matches
--    what fastrack-receive would have written had the transaction succeeded).
INSERT INTO crm.lead_notes (
  submission_id, provider_id, provider_user_id,
  author_role, author_user_id, author_display_name, body
) VALUES (
  416, 'enterprise-made-simple', NULL,
  'system', NULL, 'Switchable',
  'Learner self-flagged L3 mismatch on the fastrack form. Auto-moved to Lost (reason: L3 self-reported mismatch). Replay of fastrack-receive auto-DQ that failed RLS on 2026-05-13T06:33:06Z; see data-ops/028.'
);

-- 3. Audit trail.
SELECT audit.log_system_action(
  'data_ops:028',
  'mark_outcome_auto_dq',
  'crm.enrolments',
  (SELECT id::text FROM crm.enrolments WHERE submission_id = 416 AND provider_id = 'enterprise-made-simple'),
  jsonb_build_object('status', 'open', 'lost_reason', NULL),
  jsonb_build_object('status', 'lost', 'lost_reason', 'l3_mismatch_self_reported'),
  jsonb_build_object(
    'submission_id', 416,
    'source', 'data_ops:028_replay_emma_newton_l3_mismatch_2026_05_13',
    'reason', 'fastrack-receive transaction rolled back due to RLS gap on crm.lead_notes; fixed in migration 0139; this replays the intended state'
  )
);

-- 4. Mark the dead_letter row resolved.
UPDATE leads.dead_letter
   SET replayed_at = now(),
       replay_submission_id = 416
 WHERE error_context LIKE '%submission_id=416%l3_mismatch_self_reported%'
   AND replayed_at IS NULL;

-- Verification
SELECT id, submission_id, status, lost_reason, status_updated_at
  FROM crm.enrolments WHERE submission_id = 416;

SELECT id, author_role, body, created_at
  FROM crm.lead_notes WHERE submission_id = 416;

SELECT id, replayed_at, error_context
  FROM leads.dead_letter
 WHERE error_context LIKE '%submission_id=416%';

COMMIT;
