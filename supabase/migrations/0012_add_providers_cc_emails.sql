-- Migration 0012 - Add crm.providers.cc_emails for per-provider notification CCs
-- Date: 2026-04-21 (Session 5)
-- Author: Claude (Session 5) with owner review
-- Reason: Provider notifications from routing-confirm go to contact_email only
--         today. Courses Direct explicitly wants Ranjit (co-director, runs
--         4pm strategy calls) CC'd on every lead. Hardcoding a CC list per
--         provider in Edge Function source is wrong - it should live with
--         the provider row.
--
--         Using TEXT[] (not a join table) because:
--         - pilot volume is tiny; normalisation cost > benefit
--         - CC list changes per provider maybe once a year
--         - routing-confirm reads it with one SELECT of the provider row
--         - migration to a `provider_contacts` junction is trivial if needed
--           later (addresses migrate, CC-flag becomes a boolean)
--
-- Related:
--   - platform/docs/data-architecture.md (crm.providers section updated)
--   - platform/docs/changelog.md (Session 5 entry)
--   - platform/supabase/functions/routing-confirm/index.ts (reads cc_emails in Session 5)
--   - platform/supabase/data-ops/007_session_5_provider_seeds.sql (seeds values)
--
-- Nature: additive. NOT NULL DEFAULT '{}' means existing rows get an empty
-- array; no data migration needed.
--
-- RLS: existing crm.providers policies cover the new column without change.

-- UP
ALTER TABLE crm.providers
  ADD COLUMN cc_emails TEXT[] NOT NULL DEFAULT '{}';

-- DOWN
-- ALTER TABLE crm.providers DROP COLUMN cc_emails;
-- Safe to drop. No downstream consumer reads it before the Session 5 deploy
-- of routing-confirm. If rolled back post-deploy, redeploy the prior
-- routing-confirm revision that does not reference cc_emails first.
