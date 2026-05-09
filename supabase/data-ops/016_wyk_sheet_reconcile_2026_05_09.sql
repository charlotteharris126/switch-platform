-- Data fix 016 — WYK sheet → DB reconcile, 2026-05-09
-- Date:   2026-05-09
-- Owner:  Charlotte (decided 2026-05-09 ahead of re-enabling the auto-flip cron)
-- Reason: Pre-flight reconcile of WYK Digital's enrolment state. Charlotte
--         confirmed the WYK sheet held terminal-status outcomes for 9 leads
--         that the DB still showed as 'open' — provider has been working
--         the leads via the sheet but no sheet → DB mirror exists, so the
--         signal never propagated. Without this reconcile, tomorrow's
--         06:00 UTC auto-flip cron (re-enabled in migration 0097, which
--         is gated on this reconcile + day-12 warning template + provider
--         heads-up) would auto-flip these 9 to presumed_enrolled despite
--         the provider having already reached terminal verdicts.
--
--         Also caught one anomaly: submission 96 (Naomi Oikonomou,
--         naomi@petsapp.com) is linked as a dedup child of submission 58
--         (Naomi Oikonomou, nj3nkin5@gmail.com) but was independently
--         routed to WYK with its own routing_log entry (id 38). Sheet
--         tracks them as two separate leads. WYK has marked 96 as Lost.
--         No enrolment row exists for 96 — this script INSERTs one with
--         status='lost' to lock it in (preventing tomorrow's cron from
--         creating a presumed_enrolled row for it instead).
--
--         Submission 99 (duplicate of 98, Yousra Hassein) is correctly
--         is_dq=true with dq_reason='duplicate_of_submission_98' — won't
--         flip, no action needed.
--
-- Effect:
--   1. 9 UPDATEs to crm.enrolments (open → cannot_reach × 3, open → lost × 6)
--      mirroring what WYK has recorded on their sheet.
--   2. 1 INSERT to crm.enrolments for submission 96 (no prior enrolment row)
--      with status='lost', preventing tomorrow's cron from creating a
--      presumed_enrolled row.
--   3. audit.log_system_action entries for all 10 changes, attributed to
--      'system:manual:charlotte' with WYK-sheet-reconcile rationale.
--   4. Brevo resync via crm.sync_leads_to_brevo for all 10 submissions so
--      SW_ENROL_STATUS reflects the corrected state.
--
-- Lost rows take lost_reason='other' (sheet provides no sub-reason). The
-- WYK sheet column says simply "Lost"; default to 'other' rather than
-- guess at sub-reason.
--
-- Pre-condition: this script runs BEFORE migration 0097 is applied. After
-- this reconcile, the next "what would flip tomorrow" query should show
-- WYK at zero leads in scope.

BEGIN;

-- ─── 1. UPDATEs: 9 open → terminal transitions ────────────────────────────

-- 49 Ruby Marle: open → cannot_reach
UPDATE crm.enrolments
   SET status            = 'cannot_reach',
       status_updated_at = now(),
       updated_at        = now()
 WHERE submission_id = 49 AND provider_id = 'wyk-digital' AND status = 'open';

-- 51 Laura Hawdon: open → lost
UPDATE crm.enrolments
   SET status            = 'lost',
       lost_reason       = 'other',
       status_updated_at = now(),
       updated_at        = now()
 WHERE submission_id = 51 AND provider_id = 'wyk-digital' AND status = 'open';

-- 56 Zoya M: open → lost
UPDATE crm.enrolments
   SET status            = 'lost',
       lost_reason       = 'other',
       status_updated_at = now(),
       updated_at        = now()
 WHERE submission_id = 56 AND provider_id = 'wyk-digital' AND status = 'open';

-- 58 Naomi Oikonomou (nj3nkin5): open → cannot_reach
UPDATE crm.enrolments
   SET status            = 'cannot_reach',
       status_updated_at = now(),
       updated_at        = now()
 WHERE submission_id = 58 AND provider_id = 'wyk-digital' AND status = 'open';

-- 69 Juan Saludsong: open → lost
UPDATE crm.enrolments
   SET status            = 'lost',
       lost_reason       = 'other',
       status_updated_at = now(),
       updated_at        = now()
 WHERE submission_id = 69 AND provider_id = 'wyk-digital' AND status = 'open';

-- 70 Bhoomi Maru: open → lost
UPDATE crm.enrolments
   SET status            = 'lost',
       lost_reason       = 'other',
       status_updated_at = now(),
       updated_at        = now()
 WHERE submission_id = 70 AND provider_id = 'wyk-digital' AND status = 'open';

-- 91 Farida Abimbola: open → cannot_reach
UPDATE crm.enrolments
   SET status            = 'cannot_reach',
       status_updated_at = now(),
       updated_at        = now()
 WHERE submission_id = 91 AND provider_id = 'wyk-digital' AND status = 'open';

-- 92 Tetyana Bazylevych: open → lost
UPDATE crm.enrolments
   SET status            = 'lost',
       lost_reason       = 'other',
       status_updated_at = now(),
       updated_at        = now()
 WHERE submission_id = 92 AND provider_id = 'wyk-digital' AND status = 'open';

-- 98 Yousra Hassein: open → lost
UPDATE crm.enrolments
   SET status            = 'lost',
       lost_reason       = 'other',
       status_updated_at = now(),
       updated_at        = now()
 WHERE submission_id = 98 AND provider_id = 'wyk-digital' AND status = 'open';

-- ─── 2. INSERT: enrolment row for submission 96 (no prior row) ───────────

-- 96 Naomi Oikonomou (naomi@petsapp.com): no enrolment row in DB, sheet
-- shows Lost. Anomalous because it was linked to 58 as a dedup child but
-- routed independently. Insert a closed enrolment row to lock it in.
INSERT INTO crm.enrolments (
  submission_id, routing_log_id, provider_id, status, lost_reason,
  sent_to_provider_at, status_updated_at,
  notes
) VALUES (
  96, 38, 'wyk-digital', 'lost', 'other',
  '2026-04-22T23:00:00.000Z'::timestamptz, now(),
  'Reconciled from WYK sheet 2026-05-09. Linked as dedup child of submission 58 but independently routed (routing_log id 38). Sheet tracks as separate lead with status=Lost. Enrolment row created via data-ops/016 to prevent auto-flip from creating presumed_enrolled.'
);

-- ─── 3. Audit log entries for all 10 corrections ──────────────────────────

DO $$
DECLARE
  v_lost_ids    BIGINT[] := ARRAY[51, 56, 69, 70, 92, 98];
  v_unreach_ids BIGINT[] := ARRAY[49, 58, 91];
  v_id          BIGINT;
BEGIN
  -- 6 lost transitions
  FOREACH v_id IN ARRAY v_lost_ids LOOP
    PERFORM audit.log_system_action(
      p_actor        := 'system:manual:charlotte',
      p_action       := 'sheet_reconcile_status_correction',
      p_target_table := 'crm.enrolments',
      p_target_id    := (SELECT id::text FROM crm.enrolments WHERE submission_id = v_id AND provider_id = 'wyk-digital'),
      p_before       := jsonb_build_object('status', 'open'),
      p_after        := jsonb_build_object('status', 'lost', 'lost_reason', 'other'),
      p_context      := jsonb_build_object(
        'submission_id', v_id,
        'provider_id', 'wyk-digital',
        'reason', 'WYK sheet shows Lost; reconcile pre-flight before re-enabling auto-flip cron',
        'data_ops_script', '016_wyk_sheet_reconcile_2026_05_09'
      )
    );
  END LOOP;

  -- 3 cannot_reach transitions
  FOREACH v_id IN ARRAY v_unreach_ids LOOP
    PERFORM audit.log_system_action(
      p_actor        := 'system:manual:charlotte',
      p_action       := 'sheet_reconcile_status_correction',
      p_target_table := 'crm.enrolments',
      p_target_id    := (SELECT id::text FROM crm.enrolments WHERE submission_id = v_id AND provider_id = 'wyk-digital'),
      p_before       := jsonb_build_object('status', 'open'),
      p_after        := jsonb_build_object('status', 'cannot_reach'),
      p_context      := jsonb_build_object(
        'submission_id', v_id,
        'provider_id', 'wyk-digital',
        'reason', 'WYK sheet shows Cannot reach; reconcile pre-flight before re-enabling auto-flip cron',
        'data_ops_script', '016_wyk_sheet_reconcile_2026_05_09'
      )
    );
  END LOOP;

  -- Submission 96 INSERT
  PERFORM audit.log_system_action(
    p_actor        := 'system:manual:charlotte',
    p_action       := 'sheet_reconcile_enrolment_insert',
    p_target_table := 'crm.enrolments',
    p_target_id    := (SELECT id::text FROM crm.enrolments WHERE submission_id = 96 AND provider_id = 'wyk-digital'),
    p_before       := NULL,
    p_after        := jsonb_build_object('status', 'lost', 'lost_reason', 'other'),
    p_context      := jsonb_build_object(
      'submission_id', 96,
      'provider_id', 'wyk-digital',
      'reason', 'Dedup child of 58 but independently routed (routing_log 38). WYK sheet tracks as separate lead with status=Lost. Insert prevents tomorrow''s auto-flip from creating presumed_enrolled.',
      'data_ops_script', '016_wyk_sheet_reconcile_2026_05_09'
    )
  );
END $$;

-- ─── 4. Brevo resync — push SW_ENROL_STATUS for all 10 contacts ──────────
SELECT crm.sync_leads_to_brevo(ARRAY[49, 51, 56, 58, 69, 70, 91, 92, 96, 98]::BIGINT[]);

-- ─── Verification ──────────────────────────────────────────────────────
SELECT
  e.submission_id,
  s.first_name || ' ' || s.last_name AS name,
  e.status,
  e.lost_reason,
  e.status_updated_at::timestamp(0) AS updated
  FROM crm.enrolments e
  JOIN leads.submissions s ON s.id = e.submission_id
 WHERE e.submission_id IN (49, 51, 56, 58, 69, 70, 91, 92, 96, 98)
   AND e.provider_id = 'wyk-digital'
 ORDER BY e.submission_id;

-- Cross-check: the auto-flip eligibility query should now show ZERO WYK leads.
SELECT COUNT(*) AS wyk_still_eligible_for_auto_flip
  FROM crm.enrolments e
  JOIN leads.routing_log rl ON rl.id = e.routing_log_id
  JOIN leads.submissions s ON s.id = e.submission_id
 WHERE e.status = 'open'
   AND e.provider_id = 'wyk-digital'
   AND rl.routed_at < now() - INTERVAL '14 days'
   AND s.is_dq = false
   AND s.archived_at IS NULL;

COMMIT;
