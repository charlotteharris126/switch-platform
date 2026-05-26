-- Migration 0173 — editorial.posts featured → featured_position (up to 3 slots)
-- Date: 2026-05-26
-- Author: Claude (Sasha, platform session) with owner sign-off
-- Reason:
--   The featured boolean only ever supported a single hero post. Charlotte
--   wants 3 ranked featured slots managed from a centralised admin page,
--   not via per-post checkboxes scattered through editing flows. This
--   migration swaps featured BOOLEAN for featured_position INTEGER (1-3,
--   nullable). The partial unique index on (featured) is replaced by one
--   on (featured_position) so only one post per slot is possible.
--
--   Backfill: any post currently featured=TRUE lands in slot 1.
--
-- Related:
--   - 0171_editorial_audit_fixes.sql (introduced the partial unique index
--     posts_only_one_featured on featured WHERE featured=TRUE; replaced here)
--   - 0163_editorial_schema_blog_cms.sql (original featured column)
--   - platform/app/app/admin/blog/featured/page.tsx (new admin surface)
--   - platform/app/app/admin/blog/actions.ts (setFeaturedPositionAction)
--   - switchable/site/deploy/scripts/build-blog-posts.js (reads featured_position)
--
-- Impact assessment:
--   1. Change: drop posts_only_one_featured index; drop featured column;
--      add featured_position INTEGER CHECK BETWEEN 1 AND 3; partial unique
--      index on (featured_position) WHERE NOT NULL.
--   2. Readers / writers: admin actions (write), build script (read).
--      Need updating in lockstep with this migration.
--   3. Schema_version: no payload contract bumped.
--   4. Data migration: featured=TRUE → featured_position=1.
--   5. Rollback: see DOWN.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Add new column.
-- ---------------------------------------------------------------------------

ALTER TABLE editorial.posts
  ADD COLUMN IF NOT EXISTS featured_position INTEGER
  CHECK (featured_position IS NULL OR featured_position BETWEEN 1 AND 3);

COMMENT ON COLUMN editorial.posts.featured_position IS
  'Ranked featured slot (1, 2, or 3). 1 = lead hero card on /the-switch/; 2 + 3 = secondary cards. NULL = not featured. Managed from /admin/blog/featured.';

-- ---------------------------------------------------------------------------
-- 2. Backfill from the old boolean. Old single-featured row becomes slot 1.
-- ---------------------------------------------------------------------------

UPDATE editorial.posts
SET featured_position = 1
WHERE featured = TRUE
  AND featured_position IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Replace the partial unique index. Drop the old one (from 0171) and
--    add the new one keyed on featured_position.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS editorial.posts_only_one_featured;

CREATE UNIQUE INDEX IF NOT EXISTS posts_one_per_featured_position
  ON editorial.posts (featured_position)
  WHERE featured_position IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Drop the old column. Backwards-compat shim is not needed — the only
--    consumers are this codebase's admin actions + build script, both
--    updated in lockstep.
-- ---------------------------------------------------------------------------

ALTER TABLE editorial.posts
  DROP COLUMN IF EXISTS featured;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
--   ALTER TABLE editorial.posts ADD COLUMN featured BOOLEAN NOT NULL DEFAULT FALSE;
--   UPDATE editorial.posts SET featured = TRUE WHERE featured_position = 1;
--   DROP INDEX IF EXISTS editorial.posts_one_per_featured_position;
--   CREATE UNIQUE INDEX posts_only_one_featured ON editorial.posts (featured) WHERE featured = TRUE;
--   ALTER TABLE editorial.posts DROP COLUMN featured_position;
-- COMMIT;
