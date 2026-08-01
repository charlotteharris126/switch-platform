-- Migration 0233 — add leads.submissions.business_status
-- Date: 2026-07-30
-- Author: Claude (Mable/switchable-site) with owner sign-off
-- Reason: three new funded courses (EMS York & North Yorkshire Combined
--   Authority Skills Bootcamps: digital-edge, immediate-impact,
--   creative-catapult) add a business-status gate. Unlike age / prior_level_3 /
--   employment / earnings, this is a course ENTRY + funding gate for
--   business-owner Skills Bootcamps: the learner picks sole_trader /
--   limited_company / partnership (pass) or not_trading. not_trading DQs on
--   Digital Edge + Immediate Impact and passes on Creative Catapult (per-course
--   allow-list eligibility.business_status). The captured value drives the
--   90/100% funding split (sole traders 100%; limited companies 90% + 10%
--   co-invest) the provider settles at enrolment, so without persistence the
--   provider receives a lead with no indication of the learner's business
--   structure. Per Mable's push 2026-07-30 (funded-funnel-architecture.md).
--   Mirrors 0224 (support_role_sector) exactly. Additive (data-infra §2, free).
-- Impact (§8): additive nullable column on leads.submissions. readonly_analytics
--   still has raw SELECT on the table (legacy per §6a), so the column is
--   auto-readable for reporting (quasi-identifier, not PII). No existing consumer
--   reads it yet. Producer = the funded form (netlify-lead-router via
--   _shared/ingest.ts + _shared/route-lead.ts). Consumers to follow: provider
--   portal lead detail and admin lead detail. schema_version: producer doc
--   updated additively (switchable/site/docs/funded-funnel-architecture.md),
--   no bump. Deploy order: apply this migration FIRST, then redeploy the EFs
--   importing the changed _shared modules (netlify-lead-router,
--   netlify-leads-reconcile, and every route-lead.ts importer). Rollback = drop.
-- Related: switchable/site/docs/funded-funnel-architecture.md,
--   platform/docs/data-architecture.md (leads.submissions)

-- UP
ALTER TABLE leads.submissions ADD COLUMN IF NOT EXISTS business_status text NULL;
COMMENT ON COLUMN leads.submissions.business_status IS
  'Declared business status from the funded business_status qualifier step. sole_trader / limited_company / partnership (pass) / not_trading (DQ on Digital Edge + Immediate Impact, pass on Creative Catapult). Drives the 90/100% Skills Bootcamp funding split. NULL on courses without the step. Added 2026-07-30 for the EMS York & North Yorkshire Skills Bootcamps.';

-- DOWN
-- ALTER TABLE leads.submissions DROP COLUMN IF EXISTS business_status;
