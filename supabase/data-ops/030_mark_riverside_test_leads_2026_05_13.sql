-- Data-ops 030 — mark routed-to-Riverside owner-test leads as is_dq + clean their enrolment rows
-- Date:   2026-05-13
-- Owner:  Charlotte
-- Reason:
--   Five employer-lead submissions (423, 424, 425, 426, 427) routed to
--   riverside-training during the 13 May GTM/CAPI verification work. None
--   are real ad-driven leads — all owner-test traffic from Charlotte and
--   Kieran. The Edge Function's OWNER_TEST_EMAILS pattern didn't catch
--   them (kieranwrites@gmail.com isn't on the list; the hello+capittest /
--   hello+123capi / hello+kierantest variants on switchable.careers/.org.uk
--   were submitted before the gate caught them or fell outside the patterns).
--
--   They left is_dq=false in leads.submissions and an open crm.enrolments
--   row each (542-546), so Jane sees them in her Riverside sheet and the
--   provider portal queries would surface them too.
--
--   Per Charlotte 2026-05-13: every routed-to-Riverside lead to date is
--   a test lead. Real Riverside traffic starts after the Wed paid-traffic
--   flip is confirmed in Meta Events Manager (Solis Session 3 next step 1).
--   Going forward, real ad-driven leads will pass through without DQ; the
--   Edge Function's email-pattern gate continues to catch tests.
--
--   Submissions are KEPT with is_dq=true and dq_reason='owner_test_submission'
--   (the convention already in use, see ids 421/422). Downstream enrolments
--   are deleted (same pattern as data-ops 027). Routing_log rows stay as
--   audit trail.
--
-- Side effects:
--   - Jane's Riverside sheet still shows these rows. Charlotte cleans the
--     sheet manually after the script runs (5 rows: Switchable Ltd TEST /
--     Switchable Ltd entries from 20:25 to 21:23 on 13 May).
--   - Any U1 employer-ack emails already fired (per the Edge Function's
--     ack step). No reversal needed — Charlotte is the recipient.
--   - U2 provider notify emails to Jane were turned off before these
--     fired (handoff: 'Charlotte turned off Jane's email'); no further
--     reversal needed.
--
-- Related:
--   - platform/supabase/data-ops/027_delete_stale_test_enrolments_2026_05_12.sql (same pattern)
--   - feedback memory: 'is_dq=true, dq_reason=owner_test*' = single source of truth for test rows
--   - Solis Session 3 handoff cross-project push to Sasha

BEGIN;

-- 1. Preview: list the rows we're about to mutate.
SELECT
  s.id AS submission_id,
  s.is_dq,
  s.dq_reason,
  s.email,
  s.company_name,
  s.created_at,
  e.id AS enrolment_id,
  e.status AS enrolment_status
FROM leads.submissions s
LEFT JOIN crm.enrolments e
  ON e.submission_id = s.id AND e.provider_id = 'riverside-training'
WHERE s.id IN (423, 424, 425, 426, 427)
ORDER BY s.id;

-- 2. Flip submissions to is_dq=true.
UPDATE leads.submissions
   SET is_dq      = true,
       dq_reason  = 'owner_test_submission',
       updated_at = now()
 WHERE id IN (423, 424, 425, 426, 427)
   AND is_dq IS FALSE;

-- 3. Audit each submission flip BEFORE the enrolment delete (so the audit
--    row references the live submission state at the moment we acted).
DO $$
DECLARE
  sid bigint;
BEGIN
  FOREACH sid IN ARRAY ARRAY[423, 424, 425, 426, 427]::bigint[]
  LOOP
    PERFORM audit.log_system_action(
      'data_ops:030',
      'mark_owner_test_submission',
      'leads.submissions',
      sid::text,
      jsonb_build_object('is_dq', false, 'dq_reason', NULL),
      jsonb_build_object('is_dq', true, 'dq_reason', 'owner_test_submission'),
      jsonb_build_object(
        'submission_id', sid,
        'provider_id', 'riverside-training',
        'source', 'data_ops:030_mark_riverside_test_leads_2026_05_13',
        'reason', 'routed-to-Riverside pre-launch owner test; not caught by Edge Function email-pattern gate'
      )
    );
  END LOOP;
END $$;

-- 4. Delete downstream crm.enrolments rows (mirrors data-ops 027 pattern;
--    submissions are kept for audit, enrolments do not need to persist).
DELETE FROM crm.enrolments
 WHERE submission_id IN (423, 424, 425, 426, 427)
   AND provider_id = 'riverside-training';

-- 5. Verification: submissions now DQ, no enrolment rows remain.
SELECT id, is_dq, dq_reason
  FROM leads.submissions
 WHERE id IN (423, 424, 425, 426, 427)
 ORDER BY id;

SELECT count(*) AS remaining_enrolments
  FROM crm.enrolments
 WHERE submission_id IN (423, 424, 425, 426, 427);

COMMIT;
