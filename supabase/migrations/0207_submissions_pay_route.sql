-- Migration 0207 — add leads.submissions.pay_route
-- Date: 2026-06-12
-- Author: Claude (Sasha session) on Charlotte's direction
-- Reason: Private-pay fallback shipped on switchable/site (commit c8634e6). A
--   funded-DQ learner who chooses to pay submits the main switchable-funded form
--   with hidden pay_route=private (and dq=true). This column persists that flag
--   so the router can route the lead to the provider despite is_dq, and the
--   provider sheet / reporting can tell a private (paying) enrolment from a
--   funded one. Additive, nullable. Old rows and old producers leave it NULL.
-- Related: switchable/site/docs/funded-funnel-architecture.md (pay_route field),
--   switchable/site/docs/private-pay-platform-spec.md, platform/docs/data-architecture.md.
-- Impact assessment:
--   - Changes: leads.submissions gains one nullable text column.
--   - Producers: netlify-lead-router (new _shared/ingest.ts writes it) and
--     netlify-leads-reconcile (still on old ingest until redeployed; it leaves
--     the column NULL, which is safe). Deploy order: this migration FIRST, then
--     the EF, so the EF never INSERTs a column that doesn't exist yet.
--   - Consumers: netlify-lead-router routing branch reads it; _shared/route-lead.ts
--     reads it (route despite is_dq when 'private'; provider-sheet projection).
--   - readonly_analytics already holds SELECT on leads.submissions (legacy
--     raw-PII grant), so the new column is readable with no new grant. pay_route
--     is a non-PII flag, so it is fine for the reporting role.
--   - No schema_version bump (the lead payload treats pay_route as additive).
--   - RLS: inherits leads.submissions table policy, no change.
--   - Rollback: drop the column (no data depends on it irreversibly).
--   - Sign-off: Charlotte (this session).

-- UP
ALTER TABLE leads.submissions ADD COLUMN pay_route text;

COMMENT ON COLUMN leads.submissions.pay_route IS
  'Private-pay fallback. NULL on a normal funded submission; ''private'' when the learner did not qualify for funding and chose to pay for the course (set by the switchable-funded form). The router routes private leads to the provider despite is_dq=true; billed as a normal enrolment (provider bills the learner, we bill the provider the standard fee).';

-- DOWN
-- ALTER TABLE leads.submissions DROP COLUMN pay_route;
