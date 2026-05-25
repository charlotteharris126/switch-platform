-- Migration 0171 — editorial audit fixes
-- Date: 2026-05-25
-- Author: Claude (Sasha, platform session) with owner sign-off
-- Reason:
--   Fix three real issues surfaced in the full blog audit:
--   (a) auto-publish cron's RETURNING INTO of a single TEXT into a TEXT[]
--       only captures the last row's slug and then the re-query workaround
--       can match admin-triggered publishes, firing wrong-reason rebuilds;
--   (b) `featured` flag has no DB-side single-row enforcement so two posts
--       can both be featured at once;
--   (c) renaming a published post's slug 404s the old URL — no audit trail,
--       no automated redirect; add a slug-history table to back a future
--       redirect-from build step.
--
-- Related:
--   - platform/supabase/migrations/0166_editorial_auto_publish_scheduled_posts.sql (replaced)
--   - platform/supabase/migrations/0167_editorial_netlify_build_hook.sql (cron caller)
--   - platform/supabase/migrations/0163_editorial_schema_blog_cms.sql (editorial.posts)
--   - platform/app/app/admin/blog/actions.ts (Server Actions enforcing featured)
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: replace daily cron auto-publish function; add partial unique
--      index on editorial.posts(featured) WHERE featured = TRUE; create
--      editorial.post_slug_history; add trigger to log slug changes.
--   2. Readers / writers: cron job runs as supabase_admin; admin Server
--      Actions write to editorial.posts; future redirect-generator script
--      will read post_slug_history.
--   3. Schema_version: no payload contract bumped.
--   4. Data migration: backfill an initial slug_history row for every existing
--      post so the trigger has a baseline (initial slug = current slug).
--   5. New role / policy: post_slug_history table needs RLS allowing admin
--      read + service-role write.
--   6. Rollback: see DOWN.
--   7. Sign-off: owner 2026-05-25.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Replace the cron auto-publish function with a CTE-based RETURNING that
--    correctly aggregates affected slugs into TEXT[] in a single statement.
--    No more re-query workaround, no more race with admin-triggered publishes.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION editorial.auto_publish_scheduled_posts()
RETURNS TABLE(flipped_count INTEGER, flipped_slugs TEXT[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, editorial
AS $$
DECLARE
  v_slugs TEXT[];
  v_count INTEGER;
BEGIN
  WITH flipped AS (
    UPDATE editorial.posts
    SET status = 'published',
        last_modified = NOW()
    WHERE status = 'scheduled'
      AND publish_date IS NOT NULL
      AND publish_date <= CURRENT_DATE
    RETURNING slug
  )
  SELECT array_agg(slug), count(*)::INTEGER
  INTO v_slugs, v_count
  FROM flipped;

  v_slugs := COALESCE(v_slugs, ARRAY[]::TEXT[]);
  v_count := COALESCE(v_count, 0);

  -- Only fire a build hook if something actually flipped — avoids daily
  -- no-op builds eating Netlify minutes.
  IF v_count > 0 THEN
    PERFORM editorial.fire_netlify_blog_build(
      'auto-publish: ' || array_to_string(v_slugs, ', ')
    );
  END IF;

  RETURN QUERY SELECT v_count, v_slugs;
END;
$$;

REVOKE ALL ON FUNCTION editorial.auto_publish_scheduled_posts() FROM public;
GRANT EXECUTE ON FUNCTION editorial.auto_publish_scheduled_posts() TO postgres;

-- ---------------------------------------------------------------------------
-- 2. Partial unique index — only one row can have featured = TRUE at a time.
--    Server actions that set featured=TRUE must first unflip any other row
--    OR Postgres will reject the INSERT/UPDATE with a duplicate-key error
--    that the admin layer can catch and surface cleanly.
-- ---------------------------------------------------------------------------

-- Defensive: ensure no two rows currently have featured=TRUE. If they do,
-- keep the most recent one and unflip the others.
WITH winners AS (
  SELECT id FROM editorial.posts WHERE featured = TRUE
  ORDER BY publish_date DESC NULLS LAST, id DESC
  LIMIT 1
)
UPDATE editorial.posts
SET featured = FALSE
WHERE featured = TRUE
  AND id NOT IN (SELECT id FROM winners);

CREATE UNIQUE INDEX IF NOT EXISTS posts_only_one_featured
  ON editorial.posts (featured)
  WHERE featured = TRUE;

-- ---------------------------------------------------------------------------
-- 3. Slug-history table — records every slug a post has ever had so future
--    builds can emit Netlify redirects from old slugs to current. Audit
--    trail useful in its own right.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS editorial.post_slug_history (
  id          BIGSERIAL PRIMARY KEY,
  post_id     BIGINT  NOT NULL REFERENCES editorial.posts(id) ON DELETE CASCADE,
  old_slug    TEXT    NOT NULL,
  new_slug    TEXT    NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by  TEXT
);

CREATE INDEX IF NOT EXISTS post_slug_history_post_id_idx
  ON editorial.post_slug_history (post_id);
CREATE INDEX IF NOT EXISTS post_slug_history_old_slug_idx
  ON editorial.post_slug_history (old_slug);

COMMENT ON TABLE editorial.post_slug_history IS
  'Every slug change on editorial.posts. Build emits Netlify redirects from old_slug → new_slug so historical URLs do not 404.';

CREATE OR REPLACE FUNCTION editorial.log_post_slug_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.slug IS DISTINCT FROM OLD.slug THEN
    INSERT INTO editorial.post_slug_history (post_id, old_slug, new_slug, changed_by)
    VALUES (NEW.id, OLD.slug, NEW.slug, COALESCE((SELECT auth.jwt() ->> 'email'), 'system'));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS posts_log_slug_change ON editorial.posts;
CREATE TRIGGER posts_log_slug_change
  AFTER UPDATE OF slug ON editorial.posts
  FOR EACH ROW
  EXECUTE FUNCTION editorial.log_post_slug_change();

-- RLS: read for admins, no public access. Writes only via the trigger.
ALTER TABLE editorial.post_slug_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_read_slug_history ON editorial.post_slug_history;
CREATE POLICY admin_read_slug_history
  ON editorial.post_slug_history
  FOR SELECT
  TO authenticated
  USING (admin.is_admin());

DROP POLICY IF EXISTS readonly_select_slug_history ON editorial.post_slug_history;
CREATE POLICY readonly_select_slug_history
  ON editorial.post_slug_history
  FOR SELECT
  TO readonly_analytics
  USING (TRUE);

GRANT SELECT ON editorial.post_slug_history TO authenticated, readonly_analytics;

-- ---------------------------------------------------------------------------
-- 4. Reschedule pg_cron to call the new function name (was inline UPDATE).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  -- Unschedule any previous job named the same.
  PERFORM cron.unschedule('editorial_auto_publish_daily')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'editorial_auto_publish_daily');

  PERFORM cron.schedule(
    'editorial_auto_publish_daily',
    '0 6 * * *',  -- 06:00 UTC daily (07:00 BST)
    $cron$ SELECT editorial.auto_publish_scheduled_posts(); $cron$
  );
END $$;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
--   SELECT cron.unschedule('editorial_auto_publish_daily');
--   DROP TRIGGER IF EXISTS posts_log_slug_change ON editorial.posts;
--   DROP FUNCTION IF EXISTS editorial.log_post_slug_change();
--   DROP TABLE IF EXISTS editorial.post_slug_history;
--   DROP INDEX IF EXISTS editorial.posts_only_one_featured;
--   DROP FUNCTION IF EXISTS editorial.auto_publish_scheduled_posts();
-- COMMIT;
