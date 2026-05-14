-- Data-ops 031 — delete stale test-flagged enrolment rows (Riverside gap pass)
-- Date:   2026-05-14
-- Owner:  Charlotte
-- Reason:
--   Data-ops 030 (13 May) flipped submissions 423-427 to is_dq=true and
--   deleted their downstream crm.enrolments rows. Scope was narrow (ids
--   423-427 only), which left earlier test-flagged Riverside subs whose
--   enrolment rows still sat status='open':
--     - sub 421 (hello+capitest@switchable.org.uk) → enrolment 540
--     - sub 422 (hello+newtestcapi@switchable.careers) → enrolment 541
--
--   Both submissions are already is_dq=true, dq_reason='owner_test_submission'
--   (flagged server-side at insert via OWNER_TEST_EMAILS). They never
--   needed the submissions flip — only the enrolment cleanup. Solis
--   surfaced the gap when reconciling enrolment IDs (sequence jumps
--   541 → 547 after 030, with 540 + 541 still present).
--
--   This script re-uses the broader filter from data-ops 027 ("any
--   is_dq submission in the owner-test dq_reason family") rather than
--   hardcoding ids. That makes it idempotent: re-running on a clean
--   state deletes nothing; re-running after any future gap re-fire
--   would catch the new leftovers automatically. Treat as the canonical
--   recovery script for the "test sub flipped but enrolment still open"
--   gap class until the auto-flip-and-delete trigger lands.
--
--   Submissions are KEPT (is_dq=true, dq_reason preserved) for audit.
--
-- Related:
--   - platform/supabase/data-ops/027_delete_stale_test_enrolments_2026_05_12.sql (same filter)
--   - platform/supabase/data-ops/030_mark_riverside_test_leads_2026_05_13.sql (narrower precursor)
--   - feedback memory: 'is_dq=true, dq_reason=owner_test*' = single source of truth for test rows

BEGIN;

-- 1. Preview: list the rows about to be deleted.
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

-- 2. Delete.
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

-- 3. Verification: should return zero rows.
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
