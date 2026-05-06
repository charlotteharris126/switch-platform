-- Data fix 015 — correct Lana/Lucy status mix-up from sheet row alignment bug.
-- Date:   2026-05-06
-- Owner:  Charlotte (decided 2026-05-06 after spotting the anomaly via dashboard)
-- Reason: At 09:20 UTC, the sheet-edit-mirror picked up a "Cancelled" note on
--         the EMS sheet against lead_id 'SL-26-04-0021' (Lana Ayres). Charlotte
--         clicked confirm at 09:24 UTC, flipping Lana from presumed_enrolled →
--         lost. But the editor's actual intent was to mark Lucy Hizmo as
--         cancelled — the row visible-name said Lucy, the row's lead_id
--         column said Lana. Sheet has drifted out of name/lead_id alignment;
--         root cause investigation tracked separately.
--
--         Compounding context: Lana's enrolment (id 241, EMS) was also
--         auto-flipped open → presumed_enrolled at 06:00 UTC today by the
--         enrolment-auto-flip-daily cron (now paused per migration 0080).
--         Data-ops 014 reverted 4 such auto-flips at CD + WYK but missed
--         Lana because that query was scoped to CD + WYK providers only.
--         She's the 5th overlooked auto-flip lead — same revert treatment.
--
-- Effect:
--   1. Lana (enrolment 241): lost → open. Clears the wrongly-applied
--      cancellation AND undoes today's auto-flip in one move (target state
--      is pre-cron, pre-mistake = 'open').
--   2. Lucy (enrolment 1): enrolled → lost. Apply the cancellation that
--      was intended. Lucy is EMS enrolment id=1 (first ever), within the
--      first-3-free pilot allowance, so no billing reversal needed.
--   3. Audit log entries for both, attributed to Charlotte as actor with
--      script reference for traceability.
--   4. Brevo SW_ENROL_STATUS resync for both contacts so marketing/utility
--      attribute filters see the corrected state.
--
-- Side note (does not block this fix):
--   The sheet still visually shows Lucy's name on a row with Lana's
--   lead_id. The sheet-edit-mirror won't re-trigger on the existing edit
--   (same source_log_id=37), but if EMS edits the same row again the
--   wrong-lead resolution will repeat. Needs the EMS sheet rebuilt or
--   row alignment audited before the next provider edit lands. Tracked
--   as next-steps item in platform handoff.

BEGIN;

-- 1. Revert Lana (enrolment 241): lost → open.
UPDATE crm.enrolments
   SET status               = 'open',
       lost_reason          = NULL,
       status_updated_at    = now(),
       presumed_deadline_at = NULL,
       dispute_deadline_at  = NULL,
       updated_at           = now()
 WHERE id = 241;

-- 2. Apply the cancellation correctly to Lucy (enrolment 1): enrolled → lost.
-- lost_reason allowed values per CHECK constraint: not_interested,
-- wrong_course, funding_issue, other. Learner-initiated cancellation post-
-- enrolment fits 'other' best — 'not_interested' implies pre-enrolment
-- disinterest, which doesn't match a learner who enrolled then cancelled.
-- The cancellation detail lives in the notes field so it's still searchable.
UPDATE crm.enrolments
   SET status            = 'lost',
       lost_reason       = 'other',
       notes             = 'Cancelled by learner (EMS sheet update 2026-05-06). Originally mis-attributed to Lana Ayres via sheet row alignment bug (lead_id SL-26-04-0021 mapped to Lucy''s visible row). Corrected via data-ops/015.',
       status_updated_at = now(),
       updated_at        = now()
 WHERE id = 1;

-- 3. Audit log entries for both.
DO $$
BEGIN
  -- Lana revert
  PERFORM audit.log_system_action(
    p_actor        := 'system:manual:charlotte',
    p_action       := 'manual_revert_to_open',
    p_target_table := 'crm.enrolments',
    p_target_id    := '241',
    p_before       := jsonb_build_object('status', 'lost', 'lost_reason', null),
    p_after        := jsonb_build_object('status', 'open'),
    p_context      := jsonb_build_object(
      'submission_id', 21,
      'provider_id', 'enterprise-made-simple',
      'reason', 'wrong-lead confirmation from sheet row alignment bug; lead 21 (Lana) was inadvertently confirmed lost when cancellation was for lead 25 (Lucy)',
      'data_ops_script', '015_lana_lucy_status_correction'
    )
  );
  -- Lucy correct apply
  PERFORM audit.log_system_action(
    p_actor        := 'system:manual:charlotte',
    p_action       := 'manual_status_correction',
    p_target_table := 'crm.enrolments',
    p_target_id    := '1',
    p_before       := jsonb_build_object('status', 'enrolled', 'lost_reason', null),
    p_after        := jsonb_build_object('status', 'lost', 'lost_reason', 'other'),
    p_context      := jsonb_build_object(
      'submission_id', 25,
      'provider_id', 'enterprise-made-simple',
      'reason', 'apply provider-noted cancellation to correct lead after sheet alignment bug routed it to Lana; first-3-free allowance covers — no billing implication',
      'data_ops_script', '015_lana_lucy_status_correction'
    )
  );
END $$;

-- 4. Brevo resync — push SW_ENROL_STATUS for both updated contacts.
SELECT crm.sync_leads_to_brevo(ARRAY[21, 25]::BIGINT[]);

-- ─── Verification ─────────────────────────────────────────────────────
SELECT id, submission_id, provider_id, status, lost_reason, status_updated_at, notes
  FROM crm.enrolments
 WHERE id IN (1, 241)
 ORDER BY id;

COMMIT;
