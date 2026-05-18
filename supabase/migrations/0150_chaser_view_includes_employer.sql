-- Migration 0150 — vw_enrolments_chaser_state includes s4b_employer_chaser
-- Date: 2026-05-18
-- Author: Claude (Sasha session) with owner review
-- Reason:
--   crm.vw_enrolments_chaser_state (migration 0086) derives
--   latest_chaser_at from a MAX(triggered_at) over crm.email_log filtered
--   to email_type IN ('chaser_funded', 'chaser_self'). Learner-only.
--
--   Migration 0148 added 's4b_employer_chaser' as a valid email_type for
--   the S4B employer chaser path. The provider portal lead-detail page
--   was patched same-session to include the new type in its own
--   email_log query, but every admin-side surface that reads
--   latest_chaser_at from this view (admin /admin/leads "Last chaser"
--   column, /admin/actions stale-chaser queue, /admin overview
--   stale-chaser badge counts) still shows NULL for employer leads.
--
--   Extending the IN clause makes every admin surface aware of employer
--   chasers without any further app-side change. View column shape
--   unchanged so CREATE OR REPLACE is safe (no dependent-view rebuild
--   needed).
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: CREATE OR REPLACE crm.vw_enrolments_chaser_state with the
--      extended email_type IN list. Column list, types, ordering, and
--      WITH (security_invoker = true) all unchanged.
--   2. Readers: app/admin/layout.tsx (badge counts), app/admin/leads/
--      page.tsx ("Last chaser" column), app/admin/actions/page.tsx
--      (stale-chaser queue), app/admin/page.tsx (overview badge). All
--      pick up s4b_employer_chaser automatically on next render.
--   3. Writers: none (this is a derived view).
--   4. schema_version bump: none.
--   5. Data migration: none. View is recomputed at read time.
--   6. New role / RLS: none. Grants preserved by CREATE OR REPLACE.
--   7. Rollback: re-apply migration 0086's view body (see DOWN).
--   8. Sign-off: owner (Charlotte) in session 2026-05-18.

BEGIN;

CREATE OR REPLACE VIEW crm.vw_enrolments_chaser_state
WITH (security_invoker = true) AS
SELECT
  e.*,
  (
    SELECT MAX(el.triggered_at)
      FROM crm.email_log el
     WHERE el.submission_id = e.submission_id
       AND el.email_type IN ('chaser_funded', 'chaser_self', 's4b_employer_chaser')
       AND el.status IN ('sent', 'delivered', 'opened', 'clicked')
  ) AS latest_chaser_at
FROM crm.enrolments e;

COMMENT ON VIEW crm.vw_enrolments_chaser_state IS
  'Drop-in replacement for crm.enrolments reads that need a "when was the chaser last sent" column. Exposes every enrolments column (e.*) plus a derived latest_chaser_at from MAX(triggered_at) over chaser_funded / chaser_self / s4b_employer_chaser email_log rows in healthy delivery states (sent / delivered / opened / clicked). security_invoker=true means underlying-table RLS runs as the querying role. Used by app/admin/layout.tsx badge counts, app/admin/leads/page.tsx, app/admin/actions/page.tsx, and app/admin/page.tsx overview. Created in migration 0086; extended to include s4b_employer_chaser in migration 0150.';

COMMIT;

-- DOWN
-- BEGIN;
-- CREATE OR REPLACE VIEW crm.vw_enrolments_chaser_state
-- WITH (security_invoker = true) AS
-- SELECT
--   e.*,
--   (
--     SELECT MAX(el.triggered_at)
--       FROM crm.email_log el
--      WHERE el.submission_id = e.submission_id
--        AND el.email_type IN ('chaser_funded', 'chaser_self')
--        AND el.status IN ('sent', 'delivered', 'opened', 'clicked')
--   ) AS latest_chaser_at
-- FROM crm.enrolments e;
-- COMMIT;
