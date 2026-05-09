-- Migration 0093 — Provider portal: feature flags on crm.providers
-- Date:    2026-05-08
-- Author:  Claude (platform Session 36) on Charlotte's instruction
-- Reason:  Two boolean columns on crm.providers. is_demo flags fixture-only
--          providers (the demo provider for testing + sales calls); every
--          dashboard view, billing calc, and reconcile cron filters demo
--          rows out so they never count toward real metrics. portal_enabled
--          flags whether a provider's user accounts can log into the portal
--          yet — used during cutover sequencing (EMS first, then WYK, then
--          Courses Direct) so failure mode is contained per provider.
--          Both default to false: existing rows are real-and-not-portal-yet.
--
--          Single source of truth: these flags live ONLY here. No env var
--          fallback, no config file mirror, no "if dev mode" branching.
-- Related: platform/docs/provider-portal-mvp-scoping.md
--          .claude/rules/data-infrastructure.md (additive-only migrations are free)

-- UP

ALTER TABLE crm.providers
  ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE crm.providers
  ADD COLUMN portal_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN crm.providers.is_demo IS
  'true marks a fixture provider used for testing and sales demos. All dashboard views, billing calcs, and reconcile crons must filter is_demo=true rows out so they do not pollute real metrics. Added migration 0093.';

COMMENT ON COLUMN crm.providers.portal_enabled IS
  'true means this provider can log into the portal at app.switchleads.co.uk. false means portal access is gated even if a crm.provider_users row exists. Used for staged per-provider cutover. Added migration 0093.';

-- DOWN
-- ALTER TABLE crm.providers DROP COLUMN is_demo;
-- ALTER TABLE crm.providers DROP COLUMN portal_enabled;
