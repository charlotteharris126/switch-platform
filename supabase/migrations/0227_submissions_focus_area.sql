-- Migration 0227 — add leads.submissions.focus_area
-- Date: 2026-07-23
-- Author: Claude (Sasha/platform) with owner sign-off
-- Reason: the new general employer funnel (/business/funded-training/, Mable
--   2026-07-22) replaced the single Project-Management page. It names no course,
--   so the employer form now asks "Which area are you looking to train in?" and
--   emits focus_area (management_leadership | hr_people | business_admin_ops |
--   mixed_unsure). This is the employer's self-declared training area and the
--   signal Riverside acts on, replacing the old hardcoded standards_interested
--   course name (the general page now sends standards_interested =
--   "General enquiry, provider scopes on call"). Without persistence the field
--   only survives in raw_payload JSON and never reaches the provider portal.
--   Additive (data-infra §2, free). Mirrors 0224 (support_role_sector) exactly.
-- Impact (§8): additive nullable column on leads.submissions. readonly_analytics
--   keeps raw SELECT (legacy §6a), so auto-readable for reporting (not PII).
--   Producer = the employer form via netlify-employer-lead-router. Consumer =
--   the provider portal lead detail (shipped alongside this migration). No other
--   consumer (Brevo sync, profit tracker, audit views) reads it; all are additive-
--   safe. Employer lead payload doc updated additively (data-architecture.md),
--   no schema_version bump. Rollback = drop column.

-- UP
ALTER TABLE leads.submissions ADD COLUMN IF NOT EXISTS focus_area text NULL;
COMMENT ON COLUMN leads.submissions.focus_area IS
  'Employer self-declared training area from the S4B general employer funnel focus_area step. management_leadership / hr_people / business_admin_ops / mixed_unsure. NULL on the legacy Project-Management page and on learner (funded) leads. Added 2026-07-23 for /business/funded-training/.';

-- DOWN
-- ALTER TABLE leads.submissions DROP COLUMN IF EXISTS focus_area;
