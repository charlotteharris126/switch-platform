-- Data-ops 034 — flag + clean three more Riverside pre-launch test leads
-- Date:   2026-05-15
-- Owner:  Charlotte
-- Reason:
--   Three more routed-to-Riverside test submissions landed today
--   (2026-05-15) during live U1 / U2 verification:
--     - 441 (hello+finalriversidetest1@switchable.org.uk) → enrolment 554
--     - 442 (hello+finaltest321@switchable.org.uk)        → enrolment 555
--     - 443 (hello+livetest123@switchable.org.uk)         → enrolment 556
--
--   The OWNER_TEST_EMAILS gate didn't catch these because the local
--   parts (`+finalriversidetest1`, `+finaltest321`, `+livetest123`)
--   aren't on the pattern list. All three sit at `is_dq=false` with
--   `status='open'` enrolments — visible in Riverside's portal view,
--   which Charlotte rightly doesn't want for pre-launch tests.
--
--   Same shape as data-ops 030: flips submissions to is_dq=true with
--   dq_reason='owner_test_submission', deletes downstream
--   crm.enrolments rows, one audit.log_system_action row per submission
--   flip. Submissions stay for audit trail.
--
-- Side effects:
--   - Riverside Google Sheet may carry stale test rows from these three.
--     Charlotte cleans the sheet manually after running.
--
-- Related:
--   - platform/supabase/data-ops/030_mark_riverside_test_leads_2026_05_13.sql
--   - platform/supabase/data-ops/031_delete_stale_test_enrolments_riverside_gap_2026_05_14.sql

BEGIN;

-- 1. Preview.
SELECT
  s.id AS submission_id,
  s.is_dq,
  s.dq_reason,
  s.email,
  s.created_at,
  e.id AS enrolment_id,
  e.status AS enrolment_status
FROM leads.submissions s
LEFT JOIN crm.enrolments e
  ON e.submission_id = s.id AND e.provider_id = 'riverside-training'
WHERE s.id IN (441, 442, 443)
ORDER BY s.id;

-- 2. Flip submissions.
UPDATE leads.submissions
   SET is_dq      = true,
       dq_reason  = 'owner_test_submission',
       updated_at = now()
 WHERE id IN (441, 442, 443)
   AND is_dq IS FALSE;

-- 3. Audit per submission.
DO $$
DECLARE
  sid bigint;
BEGIN
  FOREACH sid IN ARRAY ARRAY[441, 442, 443]::bigint[]
  LOOP
    PERFORM audit.log_system_action(
      'data_ops:034',
      'mark_owner_test_submission',
      'leads.submissions',
      sid::text,
      jsonb_build_object('is_dq', false, 'dq_reason', NULL),
      jsonb_build_object('is_dq', true, 'dq_reason', 'owner_test_submission'),
      jsonb_build_object(
        'submission_id', sid,
        'provider_id', 'riverside-training',
        'source', 'data_ops:034_mark_riverside_test_leads_round_3_2026_05_15',
        'reason', 'Live U1 / U2 verification tests not caught by OWNER_TEST_EMAILS gate (hello+finalriversidetest1 / hello+finaltest321 / hello+livetest123 patterns)'
      )
    );
  END LOOP;
END $$;

-- 4. Delete downstream enrolment rows.
DELETE FROM crm.enrolments
 WHERE submission_id IN (441, 442, 443)
   AND provider_id = 'riverside-training';

-- 5. Verification.
SELECT id, is_dq, dq_reason
  FROM leads.submissions
 WHERE id IN (441, 442, 443)
 ORDER BY id;

SELECT count(*) AS remaining_enrolments
  FROM crm.enrolments
 WHERE submission_id IN (441, 442, 443);

-- And confirm no Riverside enrolments remain across the full test set.
SELECT count(*) AS riverside_open_enrolments
  FROM crm.enrolments
 WHERE provider_id = 'riverside-training';

COMMIT;
