-- Migration 0172 — editorial.posts.publish_at TIMESTAMPTZ + 15-min cron
-- Date: 2026-05-25
-- Author: Claude (Sasha, platform session) with owner sign-off
-- Reason:
--   Charlotte wants to test scheduled publishing with a specific time of
--   day, not just a date. Adding publish_at (TIMESTAMPTZ) alongside the
--   existing publish_date (DATE) lets:
--     - the cron honour an exact moment when publish_at is set
--     - fall back to publish_date (06:00 UTC) for legacy / date-only posts
--     - schedule for "today at 16:30" and have the cron pick it up within
--       15 minutes (cron now runs every 15 min instead of daily).
--
--   Existing posts (publish_date set, publish_at null) get backfilled to
--   <publish_date> 06:00 UTC so the new column is canonical going forward
--   without changing any existing publish moment.
--
-- Related:
--   - 0171_editorial_audit_fixes.sql (introduced auto_publish_scheduled_posts)
--   - 0166_editorial_auto_publish_scheduled_posts.sql (original cron)
--   - platform/app/app/admin/blog/post-form.tsx (datetime input)
--   - platform/app/app/admin/blog/actions.ts (writes publish_at)
--
-- Impact assessment:
--   1. Change: add publish_at TIMESTAMPTZ column; backfill from publish_date;
--      rewrite auto_publish_scheduled_posts() to use publish_at; reschedule
--      pg_cron to every 15 minutes.
--   2. Readers / writers: build fetcher (reads publish_date for the YAML
--      output), admin Server Actions (will write publish_at going forward),
--      cron (now reads publish_at).
--   3. Schema_version: no payload contract bumped.
--   4. Data migration: backfill done in this migration (UPDATE statement).
--   5. New role / policy: none — column inherits table-level RLS.
--   6. Rollback: see DOWN.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. New column. Nullable so a post with only publish_date set still works.
-- ---------------------------------------------------------------------------

ALTER TABLE editorial.posts
  ADD COLUMN IF NOT EXISTS publish_at TIMESTAMPTZ;

COMMENT ON COLUMN editorial.posts.publish_at IS
  'Exact moment the post should go live. If null, falls back to publish_date 06:00 UTC. Cron checks NOW() >= publish_at every 15 min.';

-- Backfill existing rows. publish_date is a DATE — coerce to UTC 06:00 of
-- that day so the post lands at the same moment the old daily-cron would
-- have flipped it.
UPDATE editorial.posts
SET publish_at = (publish_date::TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '6 hours'
WHERE publish_date IS NOT NULL
  AND publish_at IS NULL;

-- Index for the cron lookup. Partial index keeps it tight — only scheduled
-- rows ever need this lookup.
CREATE INDEX IF NOT EXISTS posts_publish_at_scheduled_idx
  ON editorial.posts (publish_at)
  WHERE status = 'scheduled';

-- ---------------------------------------------------------------------------
-- 2. Rewrite auto_publish_scheduled_posts to use publish_at.
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
      AND COALESCE(
        publish_at,
        (publish_date::TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '6 hours'
      ) <= NOW()
    RETURNING slug
  )
  SELECT array_agg(slug), count(*)::INTEGER
  INTO v_slugs, v_count
  FROM flipped;

  v_slugs := COALESCE(v_slugs, ARRAY[]::TEXT[]);
  v_count := COALESCE(v_count, 0);

  IF v_count > 0 THEN
    PERFORM editorial.fire_netlify_blog_build(
      'auto-publish: ' || array_to_string(v_slugs, ', ')
    );
  END IF;

  RETURN QUERY SELECT v_count, v_slugs;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Reschedule pg_cron from daily 06:00 UTC to every 15 minutes. Posts
--    scheduled for any specific moment now land within 15 min of that
--    moment instead of waiting for the next morning.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  PERFORM cron.unschedule('editorial_auto_publish_daily')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'editorial_auto_publish_daily');

  PERFORM cron.schedule(
    'editorial_auto_publish_every_15min',
    '*/15 * * * *',  -- every 15 minutes
    $cron$ SELECT editorial.auto_publish_scheduled_posts(); $cron$
  );
END $$;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
--   SELECT cron.unschedule('editorial_auto_publish_every_15min');
--   PERFORM cron.schedule(
--     'editorial_auto_publish_daily',
--     '0 6 * * *',
--     $cron$ SELECT editorial.auto_publish_scheduled_posts(); $cron$
--   );
--   -- Revert function to publish_date-only check:
--   CREATE OR REPLACE FUNCTION editorial.auto_publish_scheduled_posts() ...
--   DROP INDEX IF EXISTS editorial.posts_publish_at_scheduled_idx;
--   ALTER TABLE editorial.posts DROP COLUMN IF EXISTS publish_at;
-- COMMIT;
