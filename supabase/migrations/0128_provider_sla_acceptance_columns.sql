-- Migration 0128 — provider SLA acceptance + auto-flip enable columns
-- Date: 2026-05-12
-- Author: Claude (Sasha)
-- Reason:
--   Three new columns on crm.providers to support the first-sign-in SLA
--   re-agreement flow and the activity-gate framework for the auto-flip
--   cron (Mira's spec carried forward through several handoffs):
--
--     - auto_flip_enabled (BOOL, default true)
--         Per-provider switch for the enrolment auto-flip cron. ON by
--         default so existing pilot providers participate; can be
--         toggled OFF per provider if they're inactive or in a special
--         arrangement (e.g. paused billing). Auto-flip cron honours this.
--
--     - sla_accepted_at (TIMESTAMPTZ, nullable)
--         When the provider most recently re-agreed to their SLA. NULL
--         means they've never accepted (the original PPA signature
--         doesn't count — the in-portal re-agreement is what unlocks
--         portal access + auto-flip). Set by the new
--         /provider/sla-agreement server action on first sign-in.
--
--     - sla_accepted_by_user_id (BIGINT, FK crm.provider_users.id)
--         Audit trail: which team member clicked accept. NULL when
--         sla_accepted_at is NULL.
--
--     - sla_accepted_version (TEXT, nullable)
--         What text/version was accepted. When the SLA copy changes
--         (e.g., new auto-flip rule, longer presumed-flip window), set
--         this to a new version string and clear sla_accepted_at to
--         force re-acceptance. Format: "v1-2026-05-12" — short and
--         comparable.
--
--   Auto-flip is gated by:
--     auto_flip_enabled = true  AND  sla_accepted_at IS NOT NULL
--   Portal layout is gated by:
--     sla_accepted_at IS NOT NULL  (otherwise redirect to /provider/sla-agreement)
--
-- Impact assessment:
--   1. Change: 4 new columns on crm.providers (1 BOOL, 1 TIMESTAMPTZ,
--      1 BIGINT, 1 TEXT). All nullable except auto_flip_enabled which
--      has a default. Existing rows take the default on insert; on this
--      ALTER they get NULL for the new columns (auto_flip_enabled gets
--      true via DEFAULT).
--   2. Readers: auto-flip cron (migration 0129), portal layout, admin
--      providers page.
--   3. Writers: portal SLA acceptance server action; admin can toggle
--      auto_flip_enabled via /admin/providers/[id] (future).
--   4. Rollback: drop the 4 columns.
--   5. Sign-off: owner pending.

BEGIN;

ALTER TABLE crm.providers
  ADD COLUMN IF NOT EXISTS auto_flip_enabled     BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sla_accepted_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_accepted_by_user_id BIGINT REFERENCES crm.provider_users(id),
  ADD COLUMN IF NOT EXISTS sla_accepted_version  TEXT;

COMMENT ON COLUMN crm.providers.auto_flip_enabled IS
  'Per-provider switch for the enrolment auto-flip cron. ON by default; can be toggled OFF to pause auto-flip for that provider (e.g. inactive pilot, billing dispute). Combined with sla_accepted_at as the activity gate.';

COMMENT ON COLUMN crm.providers.sla_accepted_at IS
  'When the provider most recently re-agreed to their SLA via the in-portal acceptance page. NULL = never accepted. Drives the first-sign-in redirect + the auto-flip activity gate.';

COMMENT ON COLUMN crm.providers.sla_accepted_by_user_id IS
  'Audit: which provider_users row clicked accept. NULL when sla_accepted_at is NULL.';

COMMENT ON COLUMN crm.providers.sla_accepted_version IS
  'Text version of the SLA they accepted. Format: "v1-2026-05-12". When SLA copy changes (new threshold, new rule), bump the version and clear sla_accepted_at to force re-acceptance.';

COMMIT;

-- DOWN
-- BEGIN;
-- ALTER TABLE crm.providers
--   DROP COLUMN IF EXISTS sla_accepted_version,
--   DROP COLUMN IF EXISTS sla_accepted_by_user_id,
--   DROP COLUMN IF EXISTS sla_accepted_at,
--   DROP COLUMN IF EXISTS auto_flip_enabled;
-- COMMIT;
