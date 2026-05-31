-- Data-op 048 — close out genuinely-dead dead_letter rows (observability cleanup)
-- Date: 2026-05-31
-- Author: Claude (Sasha session). Sasha has READ-ONLY DB access — owner applies this.
-- Reason: leads.dead_letter holds 439 unreplayed rows. drift-digest-daily (06:30 UTC) counts every
--   replayed_at IS NULL row as "unresolved", so dead historical sources inflate the number and bury
--   the live signals. This op closes ONLY sources whose root cause is already fixed. It does NOT touch
--   the 4 still-live sources, which must keep surfacing in the digest.
--
-- Confirmed counts at write time (2026-05-31):
--   Statement A clears 165 rows: edge_function_brevo_chase 139 (wrong-list-ID window, fixed S60 via
--     BREVO_LIST_ID_PROVIDER_TRIED_NO_ANSWER=11), brevo_transactional_sms 18 (one-off failed-phone batch),
--     brevo_attribute_reconcile_async_check_result 8 (async check artefacts). The other listed sources
--     currently have 0 unreplayed rows but are included so the op is complete if any are lingering.
--   After Statement A: 274 unreplayed remain, all in the 4 live sources below.
--
-- LEFT LIVE ON PURPOSE (do not add these to the clear list):
--   netlify_audit (186)            — still firing hourly. Real fix is Statement B's precondition:
--                                    delete the orphan "switchable-newsletter" Netlify form (see note).
--   sheet_drift_detected (71)      — recurs daily from EMS hand-edited status cells. Accept-or-fix
--                                    decision for Charlotte; not closed here.
--   brevo_attribute_drift (12)     — daily dry-run, ~114/393 contacts. Clears when /admin/errors
--                                    DB<->Brevo Re-sync is run. Not closed here.
--   edge_function_partial_capture  — NOT dead. "remaining connection slots reserved for SUPERUSER /
--                                    too many clients" errors landed 30-31 May. Real connection-pool
--                                    capacity signal. Leave visible until investigated.

-- ── Statement A: close confirmed-dead sources (root cause fixed) ──────────────
UPDATE leads.dead_letter
SET replayed_at = now(),
    error_context = COALESCE(error_context, '') ||
      E'\n[bulk-closed 2026-05-31 data-op 048: source root cause fixed, observability cleanup]'
WHERE replayed_at IS NULL
  AND source IN (
    'edge_function_brevo_chase',
    'edge_function_brevo_upsert',
    'edge_function_brevo_upsert_no_match',
    'reconcile_backfill',
    'edge_function_meta_ingest_upsert',
    'edge_function_meta_ingest_api',
    'brevo_attribute_reconcile_async_check_result',
    'edge_function_sheet_append',
    'fastrack_side_effect',
    'edge_function_employer_lead_router',
    'brevo_transactional',
    'brevo_consent_drift_alert',
    'brevo_transactional_sms'
  );

-- ── Statement B: clear netlify_audit history — RUN ONLY AFTER the orphan form is deleted ──
-- PRECONDITION (Charlotte, Netlify dashboard): Netlify keeps a form definition alive once it has ever
-- received a submission, even after the HTML stops referencing it. The live site already serves the
-- correct form name (switchable-blog-subscribers, verified 2026-05-31) and "switchable-newsletter"
-- exists in NO source file — it is a lingering orphan. Delete it: Netlify -> site -> Forms ->
-- switchable-newsletter (id 6a11e8e782973500084b3e70) -> delete. The hourly audit goes clean on the
-- next tick. ONLY THEN uncomment and run the statement below to clear the historical rows.
--
-- UPDATE leads.dead_letter
-- SET replayed_at = now(),
--     error_context = COALESCE(error_context, '') ||
--       E'\n[bulk-closed 2026-05-31 data-op 048B: orphan switchable-newsletter form deleted in Netlify]'
-- WHERE replayed_at IS NULL
--   AND source = 'netlify_audit';

-- Verify after apply:
--   SELECT source, count(*) FILTER (WHERE replayed_at IS NULL) AS still_open
--   FROM leads.dead_letter GROUP BY source ORDER BY still_open DESC;
-- After Statement A only: expect netlify_audit, sheet_drift_detected, brevo_attribute_drift,
--   edge_function_partial_capture remaining.
-- After Statement B too: netlify_audit drops out (until/unless the orphan form fires again).