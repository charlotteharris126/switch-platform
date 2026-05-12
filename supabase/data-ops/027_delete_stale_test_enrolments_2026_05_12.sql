-- Data-ops 027 — delete stale 'open' enrolment rows for owner-test submissions
-- Date:   2026-05-12
-- Owner:  Charlotte
-- Reason:
--   Six test submissions (3 EMS, 3 Riverside) left status='open' enrolment
--   rows in crm.enrolments. The matching leads.submissions rows are already
--   flagged is_dq=true with owner-test dq_reasons, but crm.enrolments has no
--   is_dq column, so the rows still show up in:
--     - Provider portal /provider/leads queries (Jane and Andy see them)
--     - crm.vw_provider_billing_state.still_open
--     - crm.vw_enrolments_chaser_state (chaser cron would target them)
--
--   Migration 0136 teaches the dashboard views to filter is_dq=true rows out
--   via a JOIN through leads.submissions. But the provider portal queries
--   enrolments directly. Cleanest fix is to delete the 6 stale rows.
--
--   Submissions themselves are KEPT (with is_dq=true, dq_reason='owner_test*')
--   for audit. Only the downstream enrolment rows are removed.
--
--   Set of submissions in scope: any leads.submissions row with is_dq=true and
--   dq_reason in the owner-test family. Listed below for clarity:
--     - 'owner_test'                  (today's Riverside session)
--     - 'owner_test_submission'       (older convention)
--     - 'manual_test_submission'
--     - 'post_deploy_end_to_end_test'
--     - 'test_submission_non_allowlisted_email'
--     - 'curl_direct_test'
--
--   Expected impact: exactly 6 rows deleted (3 EMS, 3 Riverside, all
--   status='open'). Other statuses ('enrolled', 'lost' etc.) on test
--   submissions are also wiped if they exist, because no test submission
--   should carry any enrolment row regardless of status.
--
-- Related:
--   - platform/supabase/migrations/0136_provider_views_exclude_dq.sql
--   - feedback memory: 'is_dq=true, dq_reason=owner_test' = single source of truth for test rows

BEGIN;

-- Dry-run preview: list the rows we're about to delete. Run this block alone
-- (with the DELETE commented out) to confirm before applying.
SELECT
  e.id AS enrolment_id,
  e.submission_id,
  e.provider_id,
  e.status,
  e.created_at,
  s.dq_reason,
  s.first_name,
  s.last_name,
  s.email
FROM crm.enrolments e
JOIN leads.submissions s ON s.id = e.submission_id
WHERE s.is_dq IS TRUE
  AND s.dq_reason IN (
    'owner_test',
    'owner_test_submission',
    'manual_test_submission',
    'post_deploy_end_to_end_test',
    'test_submission_non_allowlisted_email',
    'curl_direct_test'
  )
ORDER BY e.provider_id, e.id;

-- The delete itself.
DELETE FROM crm.enrolments
WHERE submission_id IN (
  SELECT id FROM leads.submissions
  WHERE is_dq IS TRUE
    AND dq_reason IN (
      'owner_test',
      'owner_test_submission',
      'manual_test_submission',
      'post_deploy_end_to_end_test',
      'test_submission_non_allowlisted_email',
      'curl_direct_test'
    )
);

-- Verification: should return zero rows.
SELECT count(*) AS remaining_test_enrolments
FROM crm.enrolments e
JOIN leads.submissions s ON s.id = e.submission_id
WHERE s.is_dq IS TRUE
  AND s.dq_reason IN (
    'owner_test',
    'owner_test_submission',
    'manual_test_submission',
    'post_deploy_end_to_end_test',
    'test_submission_non_allowlisted_email',
    'curl_direct_test'
  );

COMMIT;
