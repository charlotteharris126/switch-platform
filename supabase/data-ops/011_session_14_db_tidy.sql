-- data-ops 011: Session 14 DB tidy
-- Date: 2026-04-28 (Session 14 morning)
-- Author: Claude (Session 14) with owner approval
-- Reason:
--   The admin dashboard reconciliation card was showing a 1-row gap that
--   didn't reconcile (Anita's orphan from data-ops/010), plus 2 archived
--   test routing_log entries from before owner-test-overrides shipped, plus
--   9 unresolved dead_letter rows that are either historical test failures
--   or already-handled-manually situations. Owner instruction: single source
--   of truth + tidy DB before building further.
--
--   This script:
--     Part 1: DELETE routing_log entries for archived test submissions
--             (id 29 charliemarieharris, id 30 test7@testing.com). These
--             routings actually happened pre-owner-test-overrides (which
--             shipped 22 Apr) but the rows are noise now: their submissions
--             are archived, their providers (EMS) never got "real" leads
--             from them, and they pollute every per-provider count.
--     Part 2: DELETE the orphan routing_log entry for Anita (id 184). Per
--             data-ops/010 the submission is now is_dq=true with
--             primary_routed_to=NULL. Owner direction: this was a DQ lead
--             on the waitlist, should not be in routing_log at all. Audit
--             trail of the misroute lives in data-ops/010 file + changelog.
--     Part 3: Mark all 9 unresolved dead_letter rows resolved with notes:
--             - id 85 (sid 29 sheet_append fail): test row, archived
--             - id 89 (sid 90 Jodie sheet_append fail): owner added to CD
--               sheet manually, lead routed in DB
--             - id 90 (sid 109 Lesley-Ann sheet_append fail): owner added
--               to CD sheet manually, lead routed in DB
--             - ids 91-96 (6 reconcile_backfill audit rows): cron found
--               leads missing from DB and back-filled them. All 6 leads
--               are in the DB and routed correctly (verified by the
--               unique-people count).
--
-- Idempotency: Each DELETE has WHERE clauses that match zero rows on a
--   second run. UPDATE on dead_letter is guarded by replayed_at IS NULL.
--
-- Related:
--   - platform/supabase/data-ops/010_backfill_anita_dq_correction.sql
--   - platform/docs/changelog.md 2026-04-27 entries
--   - .claude/rules/data-infrastructure.md (changelog requirement)

BEGIN;

-- ─── Part 1: archived test routing_log entries ──────────────────────────
-- Verify before delete (expect: 2 rows, both pointing at archived submissions
-- with test/owner emails).
SELECT rl.id, rl.submission_id, rl.provider_id, rl.routed_at, s.email
  FROM leads.routing_log rl
  JOIN leads.submissions s ON s.id = rl.submission_id
 WHERE rl.submission_id IN (29, 30);

DELETE FROM leads.routing_log
 WHERE submission_id IN (29, 30);

-- ─── Part 2: Anita orphan routing_log ───────────────────────────────────
-- Verify (expect: 1 row, sid 184, points to a submission with is_dq=true).
SELECT rl.id, rl.submission_id, rl.provider_id, rl.routed_at, s.email,
       s.is_dq, s.dq_reason, s.primary_routed_to
  FROM leads.routing_log rl
  JOIN leads.submissions s ON s.id = rl.submission_id
 WHERE rl.submission_id = 184;

DELETE FROM leads.routing_log
 WHERE submission_id = 184;

-- ─── Part 3: dead_letter resolution ─────────────────────────────────────
-- Mark the 3 historic sheet_append failures resolved.
UPDATE leads.dead_letter
   SET replayed_at = now(),
       error_context = COALESCE(error_context, '') || E'\n[manually resolved 2026-04-28T07:30Z]: archived test row, no real failure'
 WHERE id = 85
   AND replayed_at IS NULL;

UPDATE leads.dead_letter
   SET replayed_at = now(),
       error_context = COALESCE(error_context, '') || E'\n[manually resolved 2026-04-28T07:30Z]: Jodie Mccafferty (sid 90) added to Courses Direct sheet manually 23 Apr; lead routed in DB'
 WHERE id = 89
   AND replayed_at IS NULL;

UPDATE leads.dead_letter
   SET replayed_at = now(),
       error_context = COALESCE(error_context, '') || E'\n[manually resolved 2026-04-28T07:30Z]: Lesley-Ann Cawsey (sid 109) added to Courses Direct sheet manually 23 Apr; lead routed in DB'
 WHERE id = 90
   AND replayed_at IS NULL;

-- Mark the 6 reconcile_backfill audit rows resolved (informational; leads
-- present and routed).
UPDATE leads.dead_letter
   SET replayed_at = now(),
       error_context = COALESCE(error_context, '') || E'\n[manually resolved 2026-04-28T07:30Z]: audit row from hourly reconcile cron; leads back-filled into DB and routed correctly. Verified via unique-people count reconciliation.'
 WHERE id IN (91, 92, 93, 94, 95, 96)
   AND replayed_at IS NULL;

-- ─── Verification ───────────────────────────────────────────────────────
-- Routing log row count should now be 95 - 3 = 92.
SELECT 'routing_log' AS table_name, COUNT(*) AS rows FROM leads.routing_log
UNION ALL
SELECT 'unresolved_dead_letter', COUNT(*) FROM leads.dead_letter WHERE replayed_at IS NULL;

-- Reconciliation should be exactly: routing_log_rows = unique_emails + linked_reapps + rapid_fire_dupes
-- Expect: 92 = 88 + 3 + 1 = 92 (or 89 + 3 + 0 = 92 depending on Jade rapid-fire vs unique counting).
WITH live AS (
  SELECT email, parent_submission_id
  FROM leads.submissions
  WHERE primary_routed_to IS NOT NULL AND archived_at IS NULL
)
SELECT
  (SELECT COUNT(*) FROM leads.routing_log) AS routing_log_rows,
  (SELECT COUNT(DISTINCT lower(trim(email))) FROM live WHERE email IS NOT NULL AND trim(email) <> '') AS unique_emails,
  (SELECT COUNT(*) FROM live WHERE parent_submission_id IS NOT NULL) AS linked_reapps,
  (SELECT COUNT(*) FROM live) - (SELECT COUNT(DISTINCT lower(trim(email))) FROM live WHERE email IS NOT NULL AND trim(email) <> '') AS same_email_dupes;

COMMIT;
