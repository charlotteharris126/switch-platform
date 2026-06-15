-- Migration 0211 — add leads.submissions.private_price_quoted
-- Date: 2026-06-15
-- Author: Claude (Sasha session) on Charlotte's direction
-- Reason: When a funded-DQ learner takes the pay offer, they see and accept a
--   price (the course private_option price_display, e.g. "under £1,690"). Capture
--   that on the submission so the provider portal can tell the provider the
--   learner has been price-qualified ("they've accepted ~£X"). Captured at submit
--   via a hidden field on switchable-funded; point-in-time correct (immune to
--   later YAML price changes). Additive, nullable. NULL on non-private leads.
-- Related: switchable/site funded-course.html (private_price_quoted hidden field),
--   _shared/ingest.ts (maps + inserts it), provider portal lead detail (displays it).
-- Impact assessment:
--   - Changes: leads.submissions gains one nullable text column.
--   - Producers: netlify-lead-router + netlify-leads-reconcile (new _shared/ingest.ts).
--     Deploy order: this migration FIRST, then the EFs, so they never INSERT a
--     column that doesn't exist yet.
--   - Consumers: provider portal lead detail reads it for pay_route='private' rows.
--   - Grants: authenticated and readonly_analytics both hold table-level SELECT
--     on leads.submissions (relacl authenticated=r), so the new column is readable
--     with no new grant. Non-PII (a price string), fine for the reporting role.
--   - No schema_version bump (lead payload treats it as additive).
--   - RLS: inherits the table policy, no change.
--   - Rollback: drop the column (no data depends on it irreversibly).
--   - Sign-off: Charlotte (this session).

-- UP
ALTER TABLE leads.submissions ADD COLUMN private_price_quoted text;

COMMENT ON COLUMN leads.submissions.private_price_quoted IS
  'Price the learner was shown and accepted when taking the pay offer (course private_option price_display, e.g. "under £1,690"). Captured at submit from the switchable-funded form. Only set when pay_route=''private''; NULL otherwise. Lets the provider portal show that a private-pay learner has been price-qualified.';

-- DOWN
-- ALTER TABLE leads.submissions DROP COLUMN private_price_quoted;
