-- Migration 0123 — provider agreement and SLA columns on crm.providers
-- Date: 2026-05-11
-- Author: Claude (Sasha session)
-- Reason:
--   Provider portal gets a new /provider/agreement page that shows each
--   provider's signed PPA at a glance with a clear "your side / our side"
--   summary. Currently crm.providers already has agreement_notion_page_id
--   (all 4 pilot rows are NULL) and agreement_signed_at, but nothing on:
--     - which version of the PPA they signed (v1 funded-only, v2 dual-route
--       apprenticeships + VAT clause)
--     - the bullet-point obligations split that the portal will render
--   Without these, every portal session has to fetch and parse the Notion
--   page, which is slow and brittle. The bullet split lives close to the
--   provider row so the portal renders synchronously.
--
-- Impact assessment:
--   1. Change: 3 new nullable columns on crm.providers.
--   2. Readers: new /provider/agreement page (this week), admin providers
--      view (cosmetic).
--   3. Writers: owner via /admin/providers/[id] edit (to follow), data-ops
--      seed script for the 4 pilot rows.
--   4. Schema version: provider data contract; additive.
--   5. Data migration: data-ops script seeds the 4 pilot rows separately
--      (not in this migration — keeps schema/data separated).
--   6. Role/policy: existing RLS covers (provider portal reads its own row
--      via crm.provider_user_provider_id() helper).
--   7. Rollback: DROP COLUMN.
--   8. Sign-off: owner pending.

BEGIN;

ALTER TABLE crm.providers
  ADD COLUMN IF NOT EXISTS agreement_version              TEXT
    CHECK (agreement_version IS NULL OR agreement_version IN ('v1', 'v2')),
  ADD COLUMN IF NOT EXISTS sla_provider_obligations      TEXT[],
  ADD COLUMN IF NOT EXISTS sla_switchleads_obligations   TEXT[];

COMMENT ON COLUMN crm.providers.agreement_version IS
  'PPA version signed. v1 = funded-only (EMS, CD, WYK). v2 = dual-route apprenticeships + VAT clause (Riverside).';
COMMENT ON COLUMN crm.providers.sla_provider_obligations IS
  'Bullet list of what the provider commits to. Rendered on /provider/agreement under "Your side". Short imperative bullets, one obligation per element.';
COMMENT ON COLUMN crm.providers.sla_switchleads_obligations IS
  'Bullet list of what SwitchLeads commits to. Rendered on /provider/agreement under "Our side". Same shape as sla_provider_obligations.';

COMMIT;

-- DOWN
-- BEGIN;
-- ALTER TABLE crm.providers
--   DROP COLUMN IF EXISTS agreement_version,
--   DROP COLUMN IF EXISTS sla_provider_obligations,
--   DROP COLUMN IF EXISTS sla_switchleads_obligations;
-- COMMIT;
