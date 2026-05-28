-- Migration 0175 — pg_cron schedule for the blog drafter EF
-- Date: 2026-05-28
-- Author: Claude (Sasha, platform session) with owner sign-off
-- Reason:
--   Calls the blog-draft-from-queue Edge Function Mon/Wed/Fri at 09:00 UK.
--   The EF picks the next queued post_ideas row (tier A or B), drafts it
--   via Claude, inserts as status='draft' in editorial.posts, sends
--   Charlotte a Brevo notification.
--
--   Schedule rationale: 09:00 UK is around 08:00 UTC in BST, 09:00 UTC in
--   GMT. Running the schedule at 08:00 UTC year-round means the post lands
--   around 09:00 UK in summer and 08:00 UK in winter. Acceptable — the
--   purpose is "in Charlotte's inbox when she sits down", not literally on
--   a clock.
--
-- Related:
--   - .claude/rules/editorial-rules.md §6 cadence
--   - platform/supabase/functions/blog-draft-from-queue/index.ts
--   - Migration 0167 (fire_netlify_blog_build pattern; we reuse get_shared_secret here)
--
-- Impact assessment:
--   1. Change: one cron job added. Calls EF via pg_net.http_post.
--   2. Readers / writers: cron schedule (cron.job table).
--   3. Rollback: see DOWN.

BEGIN;

-- Helper function — gets the audit shared secret + the project URL, fires
-- the EF. SECURITY DEFINER so cron (which runs as the cron role) can read
-- the vault and call pg_net regardless of the row owner's permissions.
CREATE OR REPLACE FUNCTION editorial.fire_blog_drafter_cron()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, editorial
AS $$
DECLARE
  v_secret TEXT;
  v_url    TEXT;
  v_req_id BIGINT;
BEGIN
  v_secret := public.get_shared_secret('AUDIT_SHARED_SECRET');
  IF v_secret IS NULL THEN
    RAISE WARNING 'blog-drafter-cron: AUDIT_SHARED_SECRET missing from vault — drafter skipped';
    RETURN NULL;
  END IF;

  -- Hardcoded Supabase project ref — only changes if the project moves.
  v_url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/blog-draft-from-queue';

  SELECT net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'x-audit-key', v_secret,
      'content-type', 'application/json'
    ),
    body := '{}'::JSONB,
    timeout_milliseconds := 180000  -- 3 min — Claude calls can run long, especially Tier B batches
  ) INTO v_req_id;

  RETURN v_req_id;
END;
$$;

REVOKE ALL ON FUNCTION editorial.fire_blog_drafter_cron() FROM public;
GRANT EXECUTE ON FUNCTION editorial.fire_blog_drafter_cron() TO postgres;

-- Schedule. */15 * * * * would be too aggressive (drafter is expensive +
-- Charlotte needs proofing time). 08:00 UTC on Mon/Wed/Fri.
DO $$
BEGIN
  PERFORM cron.unschedule('editorial_blog_drafter_mwf')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'editorial_blog_drafter_mwf');

  PERFORM cron.schedule(
    'editorial_blog_drafter_mwf',
    '0 8 * * 1,3,5',  -- 08:00 UTC Mon/Wed/Fri (= 09:00 UK in BST, 08:00 UK in GMT)
    $cron$ SELECT editorial.fire_blog_drafter_cron(); $cron$
  );
END $$;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
--   SELECT cron.unschedule('editorial_blog_drafter_mwf');
--   DROP FUNCTION IF EXISTS editorial.fire_blog_drafter_cron();
-- COMMIT;
