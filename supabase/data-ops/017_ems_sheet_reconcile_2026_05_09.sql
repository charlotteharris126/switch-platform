-- Data fix 017 — EMS sheet → DB reconcile, 2026-05-09
-- Date:   2026-05-09
-- Owner:  Charlotte (decided 2026-05-09 ahead of re-enabling the auto-flip cron)
-- Reason: Pre-flight reconcile of EMS enrolment state. Charlotte pasted the
--         full EMS sheet (~120+ rows). DB-vs-sheet diff surfaced 6 status
--         corrections + 2 INSERTs for dedup children that were independently
--         routed but never had enrolment rows. Most rows match — EMS has
--         been working leads consistently (44 cannot_reach + 30 lost + 9
--         enrolled + 2 presumed_enrolled in DB), the diffs are individual
--         data drift, not systemic.
--
--         Operational impact: EMS has zero leads currently in the auto-flip
--         cohort (no >14-day open submissions before this reconcile, and
--         this reconcile changes that picture only marginally — Pugh +
--         Turnbull regress from terminal back to open, Crowther + Fannan
--         move open → cannot_reach). After this reconcile, the auto-flip
--         eligibility query for EMS should be small or zero.
--
--         The 3 anomalies surfaced:
--           - 147 + 152 (Glennis Adamson): dedup children of 125 but each
--             has its own EMS routing_log entry (75 + 79). Same pattern as
--             WYK Naomi 96 in data-ops/016. Sheet shows all three Glennis
--             rows as cannot_reach. INSERT enrolment rows for 147 + 152
--             with status='cannot_reach' to lock them in.
--           - 175 (Jade millward): primary_routed_to='courses-direct', no
--             EMS routing_log entry. EMS sheet has a phantom row that
--             shouldn't be there — Jade was never routed to EMS. Skipped.
--             Worth flagging for Charlotte separately to clean up the
--             phantom EMS sheet row.
--
--         Special notes on individual transitions:
--           - 25 Lucy Hizmo (lost → enrolled): data-ops/015 force-corrected
--             her from enrolled to lost on 2026-05-06 due to a sheet
--             alignment bug. Sheet now shows status=Enrolled with notes
--             saying "cancelled". Charlotte's call 2026-05-09: Status
--             column is authoritative — if Andy hasn't moved Status off
--             Enrolled, that's his binding outcome, we mirror. The
--             "cancelled" note is informational and ambiguous (could be
--             stale alignment-bug residue from data-ops/015, or his note
--             to himself about a cancel-then-reverse sequence). She remains
--             within the first-3-free allowance, so flipping to enrolled
--             has no billing impact regardless. Worth EMS clarifying the
--             notes/status discrepancy on their side.
--           - 221 Claire Pugh + 285 Daniella Turnbull (cannot_reach → open):
--             reverse-direction transitions. Provider has the right to
--             re-open a previously-given-up lead if circumstances change
--             (lead called back, situation update, etc.). Trust the sheet.
--             Re-opens the auto-flip clock from the *original* routing date
--             though, not the re-open date — both are >14 days old, so
--             they'd be in the next auto-flip cohort once the cron re-
--             enables. Worth a heads-up to EMS via Nell that re-opening
--             a stale lead resets nothing about the 14-day clock.

BEGIN;

-- ─── 1. UPDATEs: 6 status transitions ─────────────────────────────────────

-- 25 Lucy Hizmo: lost → enrolled (Status column is authoritative; sheet shows
-- Enrolled regardless of "cancelled" in notes — EMS hasn't moved Status off
-- Enrolled, so we mirror). First-3-free allowance applies, no billing impact.
UPDATE crm.enrolments
   SET status               = 'enrolled',
       lost_reason          = NULL,
       status_updated_at    = now(),
       updated_at           = now()
 WHERE submission_id = 25 AND provider_id = 'enterprise-made-simple';

-- 132 Kate Williams: cannot_reach → lost
UPDATE crm.enrolments
   SET status               = 'lost',
       lost_reason          = 'other',
       status_updated_at    = now(),
       updated_at           = now()
 WHERE submission_id = 132 AND provider_id = 'enterprise-made-simple' AND status = 'cannot_reach';

-- 221 Claire Pugh: cannot_reach → open (provider re-opening — circumstances changed)
UPDATE crm.enrolments
   SET status               = 'open',
       lost_reason          = NULL,
       status_updated_at    = now(),
       presumed_deadline_at = NULL,
       dispute_deadline_at  = NULL,
       updated_at           = now()
 WHERE submission_id = 221 AND provider_id = 'enterprise-made-simple' AND status = 'cannot_reach';

-- 233 Kirsty Crowther: open → cannot_reach
UPDATE crm.enrolments
   SET status               = 'cannot_reach',
       status_updated_at    = now(),
       updated_at           = now()
 WHERE submission_id = 233 AND provider_id = 'enterprise-made-simple' AND status = 'open';

-- 270 Jayne Fannan: open → cannot_reach
UPDATE crm.enrolments
   SET status               = 'cannot_reach',
       status_updated_at    = now(),
       updated_at           = now()
 WHERE submission_id = 270 AND provider_id = 'enterprise-made-simple' AND status = 'open';

-- 285 Daniella Turnbull: cannot_reach → open (provider re-opening)
UPDATE crm.enrolments
   SET status               = 'open',
       lost_reason          = NULL,
       status_updated_at    = now(),
       presumed_deadline_at = NULL,
       dispute_deadline_at  = NULL,
       updated_at           = now()
 WHERE submission_id = 285 AND provider_id = 'enterprise-made-simple' AND status = 'cannot_reach';

-- ─── 2. INSERTs: enrolment rows for dedup children with independent routing ──

-- 147 Glennis Adamson (dedup child of 125, routed independently via routing_log 75)
INSERT INTO crm.enrolments (
  submission_id, routing_log_id, provider_id, status,
  sent_to_provider_at, status_updated_at,
  notes
) VALUES (
  147, 75, 'enterprise-made-simple', 'cannot_reach',
  '2026-04-24T23:00:00.000Z'::timestamptz, now(),
  'Reconciled from EMS sheet 2026-05-09. Linked as dedup child of submission 125 but independently routed (routing_log 75). Sheet tracks as separate cannot_reach row. Enrolment row created via data-ops/017.'
);

-- 152 Glennis Adamson (third dedup child, routed independently via routing_log 79)
INSERT INTO crm.enrolments (
  submission_id, routing_log_id, provider_id, status,
  sent_to_provider_at, status_updated_at,
  notes
) VALUES (
  152, 79, 'enterprise-made-simple', 'cannot_reach',
  '2026-04-25T23:00:00.000Z'::timestamptz, now(),
  'Reconciled from EMS sheet 2026-05-09. Linked as dedup child of submission 125 but independently routed (routing_log 79). Sheet tracks as separate cannot_reach row. Enrolment row created via data-ops/017.'
);

-- ─── 3. Audit log entries for all 8 changes ───────────────────────────────

DO $$
BEGIN
  -- 25 Lucy Hizmo: lost → enrolled
  PERFORM audit.log_system_action(
    p_actor        := 'system:manual:charlotte',
    p_action       := 'sheet_reconcile_status_correction',
    p_target_table := 'crm.enrolments',
    p_target_id    := (SELECT id::text FROM crm.enrolments WHERE submission_id = 25 AND provider_id = 'enterprise-made-simple'),
    p_before       := jsonb_build_object('status', 'lost', 'lost_reason', 'other'),
    p_after        := jsonb_build_object('status', 'enrolled', 'lost_reason', null),
    p_context      := jsonb_build_object(
      'submission_id', 25,
      'provider_id', 'enterprise-made-simple',
      'reason', 'EMS sheet now shows Enrolled — alignment bug from data-ops/015 resolved, learner is genuinely enrolled. Within first-3-free, no billing impact.',
      'data_ops_script', '017_ems_sheet_reconcile_2026_05_09'
    )
  );

  -- 132 Kate Williams: cannot_reach → lost
  PERFORM audit.log_system_action(
    p_actor        := 'system:manual:charlotte',
    p_action       := 'sheet_reconcile_status_correction',
    p_target_table := 'crm.enrolments',
    p_target_id    := (SELECT id::text FROM crm.enrolments WHERE submission_id = 132 AND provider_id = 'enterprise-made-simple'),
    p_before       := jsonb_build_object('status', 'cannot_reach'),
    p_after        := jsonb_build_object('status', 'lost', 'lost_reason', 'other'),
    p_context      := jsonb_build_object(
      'submission_id', 132,
      'provider_id', 'enterprise-made-simple',
      'reason', 'EMS sheet shows Lost; reconcile pre-flight before re-enabling auto-flip cron',
      'data_ops_script', '017_ems_sheet_reconcile_2026_05_09'
    )
  );

  -- 221 Claire Pugh: cannot_reach → open (re-open)
  PERFORM audit.log_system_action(
    p_actor        := 'system:manual:charlotte',
    p_action       := 'sheet_reconcile_re_open',
    p_target_table := 'crm.enrolments',
    p_target_id    := (SELECT id::text FROM crm.enrolments WHERE submission_id = 221 AND provider_id = 'enterprise-made-simple'),
    p_before       := jsonb_build_object('status', 'cannot_reach'),
    p_after        := jsonb_build_object('status', 'open'),
    p_context      := jsonb_build_object(
      'submission_id', 221,
      'provider_id', 'enterprise-made-simple',
      'reason', 'EMS sheet re-opened — provider has resumed working the lead. Auto-flip clock counts from original routing date (>14 days ago).',
      'data_ops_script', '017_ems_sheet_reconcile_2026_05_09'
    )
  );

  -- 233 Kirsty Crowther: open → cannot_reach
  PERFORM audit.log_system_action(
    p_actor        := 'system:manual:charlotte',
    p_action       := 'sheet_reconcile_status_correction',
    p_target_table := 'crm.enrolments',
    p_target_id    := (SELECT id::text FROM crm.enrolments WHERE submission_id = 233 AND provider_id = 'enterprise-made-simple'),
    p_before       := jsonb_build_object('status', 'open'),
    p_after        := jsonb_build_object('status', 'cannot_reach'),
    p_context      := jsonb_build_object(
      'submission_id', 233,
      'provider_id', 'enterprise-made-simple',
      'reason', 'EMS sheet shows Cannot reach; reconcile pre-flight before re-enabling auto-flip cron',
      'data_ops_script', '017_ems_sheet_reconcile_2026_05_09'
    )
  );

  -- 270 Jayne Fannan: open → cannot_reach
  PERFORM audit.log_system_action(
    p_actor        := 'system:manual:charlotte',
    p_action       := 'sheet_reconcile_status_correction',
    p_target_table := 'crm.enrolments',
    p_target_id    := (SELECT id::text FROM crm.enrolments WHERE submission_id = 270 AND provider_id = 'enterprise-made-simple'),
    p_before       := jsonb_build_object('status', 'open'),
    p_after        := jsonb_build_object('status', 'cannot_reach'),
    p_context      := jsonb_build_object(
      'submission_id', 270,
      'provider_id', 'enterprise-made-simple',
      'reason', 'EMS sheet shows Cannot reach; reconcile pre-flight before re-enabling auto-flip cron',
      'data_ops_script', '017_ems_sheet_reconcile_2026_05_09'
    )
  );

  -- 285 Daniella Turnbull: cannot_reach → open (re-open)
  PERFORM audit.log_system_action(
    p_actor        := 'system:manual:charlotte',
    p_action       := 'sheet_reconcile_re_open',
    p_target_table := 'crm.enrolments',
    p_target_id    := (SELECT id::text FROM crm.enrolments WHERE submission_id = 285 AND provider_id = 'enterprise-made-simple'),
    p_before       := jsonb_build_object('status', 'cannot_reach'),
    p_after        := jsonb_build_object('status', 'open'),
    p_context      := jsonb_build_object(
      'submission_id', 285,
      'provider_id', 'enterprise-made-simple',
      'reason', 'EMS sheet re-opened — provider has resumed working the lead. Auto-flip clock counts from original routing date (>14 days ago).',
      'data_ops_script', '017_ems_sheet_reconcile_2026_05_09'
    )
  );

  -- 147 Glennis Adamson INSERT
  PERFORM audit.log_system_action(
    p_actor        := 'system:manual:charlotte',
    p_action       := 'sheet_reconcile_enrolment_insert',
    p_target_table := 'crm.enrolments',
    p_target_id    := (SELECT id::text FROM crm.enrolments WHERE submission_id = 147 AND provider_id = 'enterprise-made-simple'),
    p_before       := NULL,
    p_after        := jsonb_build_object('status', 'cannot_reach'),
    p_context      := jsonb_build_object(
      'submission_id', 147,
      'provider_id', 'enterprise-made-simple',
      'routing_log_id', 75,
      'reason', 'Dedup child of 125 with independent routing (routing_log 75). EMS sheet tracks as separate cannot_reach row. Insert prevents auto-flip from creating presumed_enrolled.',
      'data_ops_script', '017_ems_sheet_reconcile_2026_05_09'
    )
  );

  -- 152 Glennis Adamson INSERT
  PERFORM audit.log_system_action(
    p_actor        := 'system:manual:charlotte',
    p_action       := 'sheet_reconcile_enrolment_insert',
    p_target_table := 'crm.enrolments',
    p_target_id    := (SELECT id::text FROM crm.enrolments WHERE submission_id = 152 AND provider_id = 'enterprise-made-simple'),
    p_before       := NULL,
    p_after        := jsonb_build_object('status', 'cannot_reach'),
    p_context      := jsonb_build_object(
      'submission_id', 152,
      'provider_id', 'enterprise-made-simple',
      'routing_log_id', 79,
      'reason', 'Dedup child of 125 with independent routing (routing_log 79). EMS sheet tracks as separate cannot_reach row. Insert prevents auto-flip from creating presumed_enrolled.',
      'data_ops_script', '017_ems_sheet_reconcile_2026_05_09'
    )
  );
END $$;

-- ─── 4. Brevo resync — push SW_ENROL_STATUS for all 8 contacts ───────────
SELECT crm.sync_leads_to_brevo(ARRAY[25, 132, 221, 233, 270, 285, 147, 152]::BIGINT[]);

-- ─── Verification ─────────────────────────────────────────────────────
SELECT
  e.submission_id,
  s.first_name || ' ' || COALESCE(s.last_name,'') AS name,
  e.status,
  e.lost_reason,
  e.status_updated_at::timestamp(0) AS updated
  FROM crm.enrolments e
  JOIN leads.submissions s ON s.id = e.submission_id
 WHERE e.submission_id IN (25, 132, 221, 233, 270, 285, 147, 152)
   AND e.provider_id = 'enterprise-made-simple'
 ORDER BY e.submission_id;

-- Cross-check: EMS auto-flip eligibility AFTER reconcile.
SELECT
  COUNT(*) AS ems_eligible_for_auto_flip,
  array_agg(s.id ORDER BY rl.routed_at) FILTER (WHERE e.status = 'open') AS still_open_submission_ids
  FROM crm.enrolments e
  JOIN leads.routing_log rl ON rl.id = e.routing_log_id
  JOIN leads.submissions s ON s.id = e.submission_id
 WHERE e.status = 'open'
   AND e.provider_id = 'enterprise-made-simple'
   AND rl.routed_at < now() - INTERVAL '14 days'
   AND s.is_dq = false
   AND s.archived_at IS NULL;

COMMIT;
