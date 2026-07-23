-- Migration 0228 — reframe Riverside b2b_trust_line off "apprenticeships"
-- Date: 2026-07-23
-- Author: Claude (Sasha/platform) with owner sign-off
-- Reason: the employer funnel moved to the general "government-funded training"
--   angle (Mable 2026-07-22, /business/funded-training/) and the owner's steer is
--   that "apprentice/apprenticeship" is gone entirely from every employer-facing
--   surface. crm.providers.b2b_trust_line renders inside the U1-employer Brevo ack
--   email ({{contact.B2B_PROVIDER_TRUST_LINE}}), and Riverside's value still
--   opened "They've been delivering apprenticeships for over 30 years...".
--   Reframed to "...delivering government-funded training for over 30 years...".
--   The YAML mirror (switchable/site/deploy/data/apprenticeship-providers/
--   riverside.yml) was updated in lockstep the same day.
-- NOTE: this is a one-row DATA change, which would normally be a data-ops script
--   run via the SQL editor. Shipped as a tracked migration here because this
--   automated session has no SQL-editor / psql write path to the main project
--   (the Supabase MCP is scoped to a different project). Idempotent by WHERE.
-- Impact (§8): single-row content update on crm.providers. Read per-send by
--   netlify-employer-lead-router (line ~542) for the Brevo U1 email. NOT a Brevo
--   *contact* attribute, so no stale-contact backfill needed. Riverside is the
--   only employer-lead provider (v1). No schema change. Rollback = restore prior
--   string (kept in git history / data-ops 045 doc).

-- UP
UPDATE crm.providers
SET b2b_trust_line = 'They''ve been delivering government-funded training for over 30 years, are rated Good by Ofsted, have a 98.4% pass rate and run programmes nationwide for employers including the NHS, BMW, MINI, Five Guys and Wiley.'
WHERE provider_id = 'riverside-training';

-- DOWN
-- UPDATE crm.providers SET b2b_trust_line = 'They''ve been delivering apprenticeships for over 30 years, are rated Good by Ofsted, have a 98.4% pass rate and run programmes nationwide for employers including the NHS, BMW, MINI, Five Guys and Wiley.' WHERE provider_id = 'riverside-training';
