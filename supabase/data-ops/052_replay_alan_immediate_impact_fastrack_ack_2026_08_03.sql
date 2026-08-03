-- Data-ops 052 — replay Alan's Immediate Impact fastrack to fire the missed qualify-ack
-- Date:   2026-08-03
-- Owner:  Charlotte (session), executed by Claude (Sasha/platform)
-- Reason:
--   Submission 758 (Alan, EMS, immediate-impact-york-north-yorkshire) fastracked
--   at 2026-08-03T06:09:40Z with business_status_reconfirmed='sole_trader',
--   cohort_confirmed=true, business_status_mismatch_flag=false — a clean qualify
--   PASS. But fastrack-receive's u_fastrack_qualified gate only fired for the
--   L3 / earnings / support-role reconfirms; the business-status clause was
--   never added when business_status shipped (0234). So Alan got neither the
--   confirmation email nor the save-number SMS. The gate fix ships today
--   (fastrack-receive deployed, businessStatusCleared added); this replays his
--   one submission through the fixed function.
--
--   Two halves:
--     (1) THIS SQL — delete the existing fastrack child row (121) and null the
--         parent's fastracked_at, so the replay POST is not swallowed by the
--         (parent_submission_id, submitted_at) ON CONFLICT DO NOTHING dedup
--         (migration 0186) that would otherwise short-circuit before the send.
--     (2) A faithful replay of Alan's ORIGINAL Netlify webhook body (preserved
--         in raw_payload, saved to scratchpad/alan_payload.json) POSTed to the
--         deployed fastrack-receive. The EF re-inserts the child row, re-stamps
--         fastracked_at, re-updates the EMS sheet in update_by_submission_id
--         mode (idempotent, same row), and — now that the gate passes — sends
--         the u_fastrack_qualified email + save-number SMS. Both are idempotent
--         on crm.email_log / crm.sms_log (prior counts were 0), so they fire
--         exactly once.
--
--   Side effects: none on the provider beyond the same sheet cells being
--   re-written to identical values. No provider email (fastrack-receive never
--   sends one). The re-inserted child row gets a new id + created_at; submitted_at
--   and all captured fields are reproduced verbatim from raw_payload.
--
-- Pre-condition: fastrack-receive deployed WITH the businessStatusCleared gate
-- (done 2026-08-03 before this ran).
-- Rollback: none needed — the replay restores an equivalent child row. If the
-- POST had failed, re-insert from scratchpad/alan_payload.json.

BEGIN;

DELETE FROM leads.fastrack_submissions WHERE id = 121;

UPDATE leads.submissions SET fastracked_at = NULL WHERE id = 758;

COMMIT;
