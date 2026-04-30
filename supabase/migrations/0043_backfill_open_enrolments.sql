-- Migration 0043 — backfill open enrolment rows for pre-0042 routed leads
-- Date: 2026-04-30
-- Author: Claude (platform session) with owner sign-off
-- Reason: Migration 0042 added crm.ensure_open_enrolment and wired
-- route-lead.ts to call it on every new route, so leads going forward
-- atomically get an enrolment row at routing time. This migration cleans up
-- the 91 active routed parents that were routed pre-0042 and have no
-- enrolment row at all (97 total routed-no-row leads on 2026-04-30, of
-- which 4 are re-application children that deliberately stay row-less and
-- 2 are DQ+archived test rows that are correctly excluded).
--
-- Behaviour:
--   - Walks leads.routing_log joined to leads.submissions, picking the
--     latest routing_log row per (submission_id, provider_id) pair so a
--     submission with multiple historical routes resolves to the most
--     recent route for sent_to_provider_at.
--   - Filters: submission must be non-DQ, non-archived, non-child
--     (parent_submission_id IS NULL). The non-child filter mirrors
--     route-lead.ts which routes children via the re_application trigger
--     but enrolment outcome lives on the parent.
--   - Calls crm.ensure_open_enrolment for each candidate. The function is
--     idempotent on (submission_id, provider_id), so existing enrolment
--     rows (12 enrolled + 3 presumed_enrolled + recent open) are
--     untouched — ON CONFLICT DO NOTHING returns the existing row's id
--     without modifying the row.
--   - sent_to_provider_at is sourced from leads.routing_log.routed_at
--     inside the function, so historical rows keep their original route
--     timestamps rather than collapsing to now().
--
-- Verification expectations:
--   The migration RAISES NOTICE with before / after counts and the delta.
--   Delta should be 91 (give or take any leads that route between the
--   diagnostic and the migration running — Phase 1 is now live so the
--   denominator drifts upward as new leads land).
--
-- Data classification per .claude/rules/data-infrastructure.md: this is a
-- one-shot data fix tied to a structural gap. Logged in
-- platform/docs/changelog.md.
--
-- Related:
--   - platform/supabase/migrations/0042_ensure_open_enrolment.sql
--   - platform/docs/changelog.md (2026-04-30 entry)

-- UP

DO $$
DECLARE
  r              RECORD;
  v_before_count INTEGER;
  v_after_count  INTEGER;
  v_loop_count   INTEGER := 0;
BEGIN
  SELECT COUNT(*) INTO v_before_count FROM crm.enrolments;

  FOR r IN
    -- Latest routing_log row per (submission_id, provider_id). DISTINCT ON
    -- collapses any historical re-routings to the most recent route per
    -- pair, which is the correct sent_to_provider_at.
    SELECT DISTINCT ON (rl.submission_id, rl.provider_id)
      rl.id            AS routing_log_id,
      rl.submission_id,
      rl.provider_id
    FROM leads.routing_log rl
    JOIN leads.submissions s ON s.id = rl.submission_id
    WHERE s.is_dq = false
      AND s.archived_at IS NULL
      AND s.parent_submission_id IS NULL
    ORDER BY rl.submission_id, rl.provider_id, rl.routed_at DESC
  LOOP
    PERFORM crm.ensure_open_enrolment(
      r.submission_id,
      r.routing_log_id,
      r.provider_id
    );
    v_loop_count := v_loop_count + 1;
  END LOOP;

  SELECT COUNT(*) INTO v_after_count FROM crm.enrolments;

  RAISE NOTICE 'crm.enrolments backfill: candidates=%, before=%, after=%, inserted=%',
    v_loop_count, v_before_count, v_after_count, v_after_count - v_before_count;
END;
$$;

-- DOWN
-- No clean DOWN. Restoring the pre-0043 state would require deleting the
-- backfilled rows by created_at window, which risks deleting any rows
-- legitimately inserted between this migration and the restore. If a
-- rollback is genuinely needed, restore from backup (per
-- .claude/rules/data-infrastructure.md section 7).
