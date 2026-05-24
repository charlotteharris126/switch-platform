-- Migration 0166 — auto-publish editorial.posts on publish_date
-- Date: 2026-05-24
-- Author: Claude (Sasha, platform session) with owner sign-off
-- Reason:
--   CMS Phase 2 #1.5 — Charlotte sets a future date + flips status to
--   'scheduled'; pg_cron flips it to 'published' on the date so she doesn't
--   have to come back to the admin to press a button. Builds the data side
--   of the auto-publish workflow. The matching Netlify Build Hook (so the
--   live site rebuilds when status flips) is S58 next-step #6 — needs a
--   Build Hook URL stored in the vault before that can be wired.
--
-- Related:
--   platform/supabase/migrations/0163_editorial_schema_blog_cms.sql
--   platform/supabase/migrations/0165_editorial_post_ideas.sql
--   platform/supabase/migrations/0158_sms_fastrack_prompt_cron.sql (cron shape mirror)
--   platform/docs/changelog.md 2026-05-24 entry
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: one SECURITY DEFINER function in editorial schema + one
--      pg_cron daily schedule that calls it.
--   2. Readers / writers: only writes to editorial.posts.status (and
--      updated_at via the trigger from 0163). No new readers. The /admin/blog
--      list page picks up the flip on next page load.
--   3. Schema_version: no contract bumped — the status enum is unchanged.
--      Only the row's status value moves from 'scheduled' → 'published'
--      programmatically.
--   4. Data migration: none on apply. The function will fire on its first
--      scheduled run and move any already-overdue scheduled posts to
--      published. None exist today.
--   5. New role / policy: none. SECURITY DEFINER so the cron-owner role can
--      bypass admin RLS for the one specific column update.
--   6. Rollback: cron.unschedule + DROP FUNCTION in DOWN.
--   7. Sign-off: owner 2026-05-24.
--
-- Why daily at 06:00 UTC (vs more frequent):
--   - Blog publish granularity is dates, not times. A post scheduled for
--     2026-06-01 should appear on 2026-06-01, not at 23:59 on 2026-05-31.
--   - 06:00 UTC = 07:00 UK BST / 06:00 UK GMT, before most commute reading.
--   - Per-run candidate count is tiny (zero on most days, single-digit on
--     publish days).
--   - Lower-cadence cron = fewer pg_cron rows in audit logs.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Function: flip scheduled posts whose publish_date has arrived.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION editorial.auto_publish_due_scheduled_posts()
RETURNS TABLE (flipped_count INTEGER, flipped_slugs TEXT[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = editorial, pg_catalog
AS $$
DECLARE
  v_flipped_slugs TEXT[];
BEGIN
  UPDATE editorial.posts
  SET
    status        = 'published',
    last_modified = NOW(),
    updated_at    = NOW()
  WHERE
    status = 'scheduled'
    AND publish_date IS NOT NULL
    AND publish_date <= CURRENT_DATE
  RETURNING slug INTO v_flipped_slugs;

  -- Aggregate the RETURNING into the OUT table. Postgres collapses a
  -- multi-row RETURNING into the last value when assigned to a scalar
  -- variable, so we re-query for the full slug list. At pilot volume the
  -- second pass costs nothing and the explicit list is useful for the
  -- audit row that consumers may read.
  SELECT array_agg(slug)
  INTO v_flipped_slugs
  FROM editorial.posts
  WHERE
    status = 'published'
    AND publish_date = CURRENT_DATE
    AND last_modified >= NOW() - INTERVAL '5 seconds';

  RETURN QUERY
  SELECT
    COALESCE(array_length(v_flipped_slugs, 1), 0),
    COALESCE(v_flipped_slugs, ARRAY[]::TEXT[]);
END;
$$;

COMMENT ON FUNCTION editorial.auto_publish_due_scheduled_posts() IS
  'Daily cron target. Flips status=''scheduled'' posts whose publish_date <= CURRENT_DATE to ''published''. Returns the count + slug list flipped on this run. SECURITY DEFINER so cron-owner can update under admin-only RLS. Netlify rebuild trigger lives separately (S58 next-step #6).';

-- Grant execute to the cron-owner role used by pg_cron (postgres in Supabase).
-- public schema would shadow editorial; explicit grant keeps the call surface
-- explicit and auditable.
GRANT EXECUTE ON FUNCTION editorial.auto_publish_due_scheduled_posts() TO postgres;

-- ---------------------------------------------------------------------------
-- 2. Schedule the daily run.
-- ---------------------------------------------------------------------------

-- Idempotent re-schedule (drop existing if any, then create).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'editorial-auto-publish-scheduled-posts') THEN
    PERFORM cron.unschedule('editorial-auto-publish-scheduled-posts');
  END IF;
END $$;

SELECT cron.schedule(
  'editorial-auto-publish-scheduled-posts',
  '0 6 * * *',  -- daily at 06:00 UTC (07:00 BST / 06:00 GMT)
  $cmd$
    SELECT * FROM editorial.auto_publish_due_scheduled_posts();
  $cmd$
);

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- SELECT cron.unschedule('editorial-auto-publish-scheduled-posts');
-- DROP FUNCTION IF EXISTS editorial.auto_publish_due_scheduled_posts();
-- COMMIT;
