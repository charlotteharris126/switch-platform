-- Data-op 049 — close out sheet_drift_detected dead_letter rows (DB is authoritative)
-- Date: 2026-06-21
-- Author: Claude (Sasha session). Sasha has READ-ONLY DB access — owner applies this.
-- Reason: data-op 048 (2026-05-31) deliberately LEFT sheet_drift_detected open as
--   "Charlotte's accept-or-fix decision". That decision is now made. The audit trail
--   (public.vw_audit_actions) shows EMS staff (nick.rodgers / george.taylor /
--   jake.balfour @enterprisemadesimple.co.uk) are marking lead outcomes in the PORTAL
--   via action=mark_outcome, surface=provider. The Google Sheet's status cells are the
--   stale side: they hold the earlier state the sheet captured and never caught up on
--   once the work moved to the portal. So in every drifted row the DB is current and the
--   sheet is behind. Nothing billable is hiding in the sheet either: "Enrolled" is a
--   value the sheet edit-mirror DOES sync, and no drift row shows a sheet "Enrolled".
--   The sheet is being retired (target 25 Jun 2026), which removes the source of this
--   drift class entirely; these rows are observability noise from here on.
--
-- Confirmed counts at write time (2026-06-21): 30 unreplayed sheet_drift_detected rows:
--   - 27 status drift (sheet status behind the DB; DB set by EMS in the portal). Spot-
--     checked the 6 that read worst (DB lost / sheet meeting-booked or attempt-1):
--     subs 438, 527, 535, 538, 552, 557 — all marked lost by EMS staff themselves in the
--     portal (438 = cohort_decline, the learner declined the cohort). Correctly lost.
--   - 3 missing_from_sheet (subs 675/676/678). These are present in leads.submissions AND
--     in crm.enrolments (the portal), status open — they only never landed in the sheet.
--     Safe to close; the portal already has them.
--
-- Scope note: closes ONLY sheet_drift_detected. The other live sources from 048
--   (netlify_audit, brevo_attribute_drift, edge_function_partial_capture) are untouched.

-- ── Close all open sheet_drift_detected rows ─────────────────────────────────
UPDATE leads.dead_letter
SET replayed_at = now(),
    error_context = COALESCE(error_context, '') ||
      E'\n[bulk-closed 2026-06-21 data-op 049: DB authoritative (EMS marks outcomes in the portal); sheet stale and being retired 25 Jun]'
WHERE replayed_at IS NULL
  AND source = 'sheet_drift_detected';

-- Verify after apply (expect sheet_drift_detected absent / 0 open):
--   SELECT source, count(*) FILTER (WHERE replayed_at IS NULL) AS still_open
--   FROM leads.dead_letter GROUP BY source ORDER BY still_open DESC;
--
-- After the sheet is retired on 25 Jun, sheet-drift-reconcile-daily should be disabled
-- (cron) or pointed away from EMS so this source stops regenerating. Track separately.
