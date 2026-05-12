-- Migration 0134 — Add crm.providers.site_slug for DB ↔ site slug mapping
-- Date: 2026-05-12
-- Author: Claude (Sasha) with owner review, Mable wired the v1 redirect site-side
-- Reason: The DB-side provider id and the site-side slug can disagree.
--         Riverside is the first case in production:
--           provider_id        = 'riverside-training' (DB)
--           data/apprenticeship-providers/<slug>.yml = 'riverside' (site)
--         Today they're reconciled implicitly because the v1 form action is
--         a static '/business/thank-you/riverside/' (Mable, commit 2efba5c).
--         The moment a second apprenticeship provider signs, the redirect
--         can no longer be a single static slug and we'll need a mapping.
--         Two places it could live:
--           (a) Hardcoded switch in code on either the Edge Function side or
--               the site build side
--           (b) A column on crm.providers carrying the canonical site slug
--         (b) wins because the DB already owns provider identity. Code-side
--         switches drift; the row is the row.
--
--         Adding as additive NULL TEXT now so:
--           - v1 carries on unchanged (no consumer reads site_slug today)
--           - we backfill Riverside immediately so the column has truth
--           - v2+ work (Edge Function deriving a thank-you slug, or the
--             build script reading it during apprenticeship-provider page
--             generation) lands against a populated column
--         Once every apprenticeship-provider row has site_slug set, we can
--         tighten to NOT NULL in a follow-up migration; deliberately not
--         doing that here because funded providers (EMS, CD, WYK) have no
--         site slug concept and shouldn't be forced to invent one.
--
--         Unique-partial-index because two providers must never claim the
--         same site URL. NULL is allowed for funded providers who don't
--         have a thank-you page.
--
-- Related:
--   - platform/docs/data-architecture.md (crm.providers section, follow-up edit)
--   - platform/docs/changelog.md (this session entry)
--   - switchable/site/CLAUDE.md § "Apprenticeship-provider YAML" (Mable, v2 options)
--   - platform/supabase/functions/netlify-employer-lead-router/index.ts (does NOT
--     read this column today; consumer wiring is a v2 concern)
--
-- Nature: additive. NULL allowed, no data migration except the Riverside
-- backfill below. No consumer reads the column at the time this ships, so
-- there is zero impact on any current code path.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Adds nullable TEXT column + partial unique index + backfills one row.
--   2. Reads: zero consumers today. Designed for future Edge Function /
--      build-script reads.
--   3. Writes: zero producers today. Future admin UI on /admin/providers/[id]
--      should surface this field for apprenticeship providers.
--   4. schema_version bump: no. This is an internal DB column, not part of
--      any external payload contract.
--   5. Data migration: trivial single-row backfill for Riverside.
--   6. New role / RLS: no. Existing crm.providers policies cover the new
--      column unchanged.
--   7. Rollback: DOWN below. Safe pre-deploy of any reader.
--   8. Sign-off: owner.

-- UP
ALTER TABLE crm.providers
  ADD COLUMN site_slug TEXT;

CREATE UNIQUE INDEX providers_site_slug_unique
  ON crm.providers (site_slug)
  WHERE site_slug IS NOT NULL;

COMMENT ON COLUMN crm.providers.site_slug IS
  'Canonical slug used by the Switchable site for per-provider pages '
  '(currently /business/thank-you/<site_slug>/). Differs from provider_id '
  'where the DB id and site URL diverged (e.g. provider_id=riverside-training, '
  'site_slug=riverside). NULL for providers with no public site page.';

-- Backfill: Riverside is the only apprenticeship provider in v1.
UPDATE crm.providers
   SET site_slug = 'riverside'
 WHERE provider_id = 'riverside-training';

-- DOWN
-- DROP INDEX IF EXISTS crm.providers_site_slug_unique;
-- ALTER TABLE crm.providers DROP COLUMN site_slug;
-- Safe to drop. No consumer reads this column at deploy time. If any v2
-- consumer is shipped before rollback, redeploy the prior consumer first.
