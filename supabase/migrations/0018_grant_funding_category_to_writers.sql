-- Migration 0018 — Grant funding_category column access to writer roles
-- Date: 2026-04-25 (incident response)
-- Author: Claude (platform Session 9 hotfix) with owner review
-- Reason: After migration 0017 added `funding_category` and Edge Functions were
--         redeployed with the new INSERT, live submissions stopped landing in
--         the DB (last successful: id 132 Kate Williams 06:46:44 BST). The
--         dead_letter fallback never caught the error, indicating a
--         column-permission failure at the SQL planner stage that throws
--         before the try/catch wraps the INSERT.
--
--         If `functions_writer` had column-level grants only (not
--         table-level), ADD COLUMN does not propagate to the new column.
--         Explicitly granting INSERT, UPDATE, SELECT on the new column to
--         every role that touches submissions and partials is the fix.
--
--         Same fix applied to `leads.partials.funding_category` defensively —
--         same pattern, same risk.
--
-- Impact: submissions resume landing in the DB. Dead-letter remains empty.
-- Owner-notification email re-fires for any backfilled leads via reconcile.
--
-- Related: platform/supabase/migrations/0017_add_funding_category.sql,
--          platform/docs/changelog.md.

-- UP

-- Grant INSERT, UPDATE, SELECT on the new column to every role that writes to
-- the table. Idempotent — re-granting an existing privilege is a no-op.

GRANT SELECT, INSERT, UPDATE (funding_category) ON leads.submissions TO functions_writer;
GRANT SELECT, INSERT, UPDATE (funding_category) ON leads.partials TO functions_writer;

-- Also ensure readonly_analytics keeps SELECT on the new column (already
-- granted by 0017's RLS hook but defensive re-grant here).

GRANT SELECT (funding_category) ON leads.submissions TO readonly_analytics;
GRANT SELECT (funding_category) ON leads.partials TO readonly_analytics;

-- DOWN
-- REVOKE SELECT, INSERT, UPDATE (funding_category) ON leads.submissions FROM functions_writer;
-- REVOKE SELECT, INSERT, UPDATE (funding_category) ON leads.partials FROM functions_writer;
-- REVOKE SELECT (funding_category) ON leads.submissions FROM readonly_analytics;
-- REVOKE SELECT (funding_category) ON leads.partials FROM readonly_analytics;
