-- Migration 0167 — Netlify Build Hook firing on auto-publish + admin publish
-- Date: 2026-05-24
-- Author: Claude (Sasha, platform session) with owner sign-off
-- Reason:
--   Closes the auto-publish loop. Migration 0166 flips status='scheduled' →
--   'published' on schedule, but the live switchable.org.uk site only
--   rebuilds on git push by default. This migration adds a Netlify Build
--   Hook trigger so the cron + manual publish both kick off a rebuild
--   automatically. Without this piece, scheduled posts sit in the DB until
--   the next unrelated push.
--
-- Wiring (one-shot setup, owner-run after this migration applies):
--   1. In Netlify dashboard for switchable.org.uk: Site settings → Build &
--      deploy → Build hooks → Add build hook. Name "Editorial CMS publish",
--      branch "main". Copy the URL it generates.
--   2. In Supabase Studio SQL editor, store it in the vault:
--        SELECT vault.create_secret(
--          '<the hook URL from step 1>',
--          'NETLIFY_SWITCHABLE_BUILD_HOOK',
--          'Netlify Build Hook for switchable.org.uk — fires from editorial.fire_netlify_blog_build()'
--        );
--   3. Test: SELECT editorial.fire_netlify_blog_build('manual-test');
--      A new deploy should start in Netlify within a few seconds.
--
-- Related:
--   platform/supabase/migrations/0019_vault_helper_for_shared_secrets.sql (secret-allowlist pattern)
--   platform/supabase/migrations/0104_extend_get_shared_secret_for_invite.sql (allowlist extension precedent)
--   platform/supabase/migrations/0166_editorial_auto_publish_scheduled_posts.sql (cron foundation)
--   platform/docs/changelog.md 2026-05-24 entry
--   switchable/site/deploy/scripts/fetch-blog-posts-from-db.js (build-side consumer)
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: extends get_shared_secret allowlist (new entry), adds
--      editorial.fire_netlify_blog_build() function, modifies
--      editorial.auto_publish_due_scheduled_posts() to call the firer after
--      a successful flip.
--   2. Readers / writers: only pg_net.http_post + net._http_response (audit
--      table). No new domain tables touched.
--   3. Schema_version: no contract bumped.
--   4. Data migration: none.
--   5. New role / policy: none. SECURITY DEFINER on the firer so the cron-
--      owner role can read the secret without holding vault access directly.
--   6. Rollback: DOWN restores 0166's auto_publish + 0104's allowlist.
--   7. Sign-off: owner 2026-05-24.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Extend the get_shared_secret allowlist with NETLIFY_SWITCHABLE_BUILD_HOOK.
--    Full replace per the pattern in 0104 — single function body, single
--    allowlist literal.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_shared_secret(p_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'vault'
AS $function$
DECLARE
  v_secret TEXT;
BEGIN
  IF p_name NOT IN (
    'AUDIT_SHARED_SECRET',
    'PROVIDER_INVITE_SECRET',
    'NETLIFY_SWITCHABLE_BUILD_HOOK'
  ) THEN
    RAISE EXCEPTION 'Secret % is not in the allowlist. Add it to public.get_shared_secret() if needed.', p_name
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT decrypted_secret
    INTO v_secret
    FROM vault.decrypted_secrets
   WHERE name = p_name
   LIMIT 1;

  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'Secret % not found in vault. Run vault.create_secret(...) first.', p_name
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN v_secret;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Firer function. Called by the cron post-flip AND by the platform admin
--    server action after a manual publish. Returns the pg_net request_id so
--    callers can log it.
--
--    Idempotent-by-Netlify: Netlify deduplicates rapid-fire build-hook calls.
--    Two flips in quick succession trigger one rebuild, not two.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION editorial.fire_netlify_blog_build(p_reason TEXT DEFAULT 'unspecified')
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, net
AS $$
DECLARE
  v_hook_url TEXT;
  v_request_id BIGINT;
BEGIN
  -- If the secret isn't set yet (first-deploy state), don't blow up the
  -- caller — just log and return NULL. Charlotte will set it once she's
  -- created the Build Hook in Netlify.
  BEGIN
    v_hook_url := public.get_shared_secret('NETLIFY_SWITCHABLE_BUILD_HOOK');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fire_netlify_blog_build: NETLIFY_SWITCHABLE_BUILD_HOOK not set (%). Skipping rebuild trigger.', SQLERRM;
    RETURN NULL;
  END;

  SELECT net.http_post(
    url := v_hook_url,
    -- Body is informational; Netlify Build Hooks accept any JSON.
    -- The reason string shows up in Netlify deploy log as the trigger source.
    body := jsonb_build_object(
      'trigger_title', 'editorial.fire_netlify_blog_build',
      'trigger_branch', 'main',
      'reason', p_reason
    ),
    headers := jsonb_build_object('content-type', 'application/json'),
    timeout_milliseconds := 15000
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;

COMMENT ON FUNCTION editorial.fire_netlify_blog_build(TEXT) IS
  'POSTs to the Netlify Build Hook for switchable.org.uk, kicking off a rebuild that picks up editorial.posts changes. Called by editorial.auto_publish_due_scheduled_posts() after a cron flip AND by the platform admin Server Action after a manual publish. Returns pg_net request_id (or NULL if the hook URL secret is unset).';

GRANT EXECUTE ON FUNCTION editorial.fire_netlify_blog_build(TEXT) TO postgres, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Update auto_publish to fire the build after a non-empty flip.
--    DROP required (not CREATE OR REPLACE) because we're widening the
--    OUT-parameter list from 0166's (count, slugs) to (count, slugs,
--    request_id). Postgres rejects return-type changes via CREATE OR REPLACE.
--    The pg_cron schedule from 0166 stores its command as text and resolves
--    the function by name at run-time, so dropping doesn't break the schedule.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS editorial.auto_publish_due_scheduled_posts();

CREATE FUNCTION editorial.auto_publish_due_scheduled_posts()
RETURNS TABLE (flipped_count INTEGER, flipped_slugs TEXT[], build_request_id BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = editorial, pg_catalog, public
AS $$
DECLARE
  v_flipped_slugs TEXT[];
  v_request_id BIGINT;
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

  -- Re-query for the full list (the variable above collapses to last row
  -- only on multi-row RETURNING — same approach as 0166).
  SELECT array_agg(slug)
  INTO v_flipped_slugs
  FROM editorial.posts
  WHERE
    status = 'published'
    AND publish_date = CURRENT_DATE
    AND last_modified >= NOW() - INTERVAL '5 seconds';

  -- Fire the rebuild only when we actually flipped something. Spares Netlify
  -- a no-op deploy on every cron tick.
  IF v_flipped_slugs IS NOT NULL AND array_length(v_flipped_slugs, 1) > 0 THEN
    v_request_id := editorial.fire_netlify_blog_build(
      format('auto-publish: %s', array_to_string(v_flipped_slugs, ','))
    );
  END IF;

  RETURN QUERY
  SELECT
    COALESCE(array_length(v_flipped_slugs, 1), 0),
    COALESCE(v_flipped_slugs, ARRAY[]::TEXT[]),
    v_request_id;
END;
$$;

COMMENT ON FUNCTION editorial.auto_publish_due_scheduled_posts() IS
  'Daily cron target. Flips status=''scheduled'' posts whose publish_date <= CURRENT_DATE to ''published'' and fires a Netlify rebuild if any posts flipped. Returns count + slugs + build_request_id. SECURITY DEFINER so the cron-owner role can update under admin-only RLS.';

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
--
-- -- Revert auto_publish to 0166 shape (no build hook).
-- CREATE OR REPLACE FUNCTION editorial.auto_publish_due_scheduled_posts()
-- RETURNS TABLE (flipped_count INTEGER, flipped_slugs TEXT[])
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = editorial, pg_catalog
-- AS $$
-- DECLARE
--   v_flipped_slugs TEXT[];
-- BEGIN
--   UPDATE editorial.posts
--   SET status = 'published', last_modified = NOW(), updated_at = NOW()
--   WHERE status = 'scheduled' AND publish_date IS NOT NULL AND publish_date <= CURRENT_DATE
--   RETURNING slug INTO v_flipped_slugs;
--   SELECT array_agg(slug) INTO v_flipped_slugs FROM editorial.posts
--    WHERE status = 'published' AND publish_date = CURRENT_DATE AND last_modified >= NOW() - INTERVAL '5 seconds';
--   RETURN QUERY SELECT COALESCE(array_length(v_flipped_slugs, 1), 0), COALESCE(v_flipped_slugs, ARRAY[]::TEXT[]);
-- END;
-- $$;
--
-- DROP FUNCTION IF EXISTS editorial.fire_netlify_blog_build(TEXT);
--
-- -- Revert allowlist to 0104 shape (no Netlify hook).
-- CREATE OR REPLACE FUNCTION public.get_shared_secret(p_name TEXT)
-- RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'vault'
-- AS $function$
-- DECLARE v_secret TEXT;
-- BEGIN
--   IF p_name NOT IN ('AUDIT_SHARED_SECRET', 'PROVIDER_INVITE_SECRET') THEN
--     RAISE EXCEPTION 'Secret % is not in the allowlist.', p_name USING ERRCODE = 'insufficient_privilege';
--   END IF;
--   SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = p_name LIMIT 1;
--   IF v_secret IS NULL THEN RAISE EXCEPTION 'Secret % not found.', p_name USING ERRCODE = 'no_data_found'; END IF;
--   RETURN v_secret;
-- END;
-- $function$;
--
-- COMMIT;
