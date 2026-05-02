-- Migration 0049 — CRM webhook token for inbound provider status updates
-- Date: 2026-05-01
-- Author: Claude (platform session) with owner sign-off
-- Reason: Two-way HubSpot integration. Providers using a CRM (Courses
-- Direct → HubSpot, Ranjit's request) need to push status updates back
-- to us so the lead pipeline stays current without them touching the
-- Google Sheet. The crm-webhook-receiver Edge Function authenticates
-- per-provider via a unique token in the URL query string. This
-- migration adds the column to store that token.
--
-- Token semantics:
--   - One token per provider, generated via openssl rand -hex 32
--   - NULL = no inbound webhook configured (most providers today)
--   - Unique index enforces no token collisions across providers
--   - Rotated annually or on suspected leak (see secrets-rotation.md)
--
-- Related:
--   - platform/supabase/functions/crm-webhook-receiver/ (consumer of token)
--   - platform/supabase/functions/_shared/route-lead.ts (already pushes to
--     crm_webhook_url; this adds the receive side)
--   - platform/docs/data-architecture.md crm.providers section

-- UP

ALTER TABLE crm.providers
  ADD COLUMN IF NOT EXISTS crm_webhook_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS crm_providers_crm_webhook_token_uniq
  ON crm.providers (crm_webhook_token)
  WHERE crm_webhook_token IS NOT NULL;

COMMENT ON COLUMN crm.providers.crm_webhook_token IS
  'HMAC-equivalent secret embedded in the inbound CRM webhook URL we give the provider. The crm-webhook-receiver Edge Function looks up which provider a request belongs to by matching this token against the URL query string. NULL = provider has no inbound webhook (sheet-only or new). Generated via openssl rand -hex 32.';

-- DOWN
-- DROP INDEX crm.crm_providers_crm_webhook_token_uniq;
-- ALTER TABLE crm.providers DROP COLUMN crm_webhook_token;
