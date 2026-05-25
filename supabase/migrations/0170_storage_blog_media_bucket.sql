-- Migration 0170 — blog-media Supabase Storage bucket + RLS policies
-- Date: 2026-05-25
-- Author: Claude (Sasha, platform session) with owner sign-off
-- Reason:
--   CMS Phase 2 — cover image uploads for blog posts. Lives in Supabase
--   Storage so URLs are stable + public + CDN-served, and so agents can
--   upload programmatically via the same surface Charlotte uses manually.
--   Posts reference uploaded images via editorial.posts.cover_image_url
--   (and other URL fields) — the schema doesn't change.
--
-- Related:
--   platform/app/app/admin/blog/actions.ts (uploadBlogMediaAction)
--   platform/app/app/admin/blog/cover-upload.tsx (UI)
--   platform/docs/changelog.md 2026-05-25 entry
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: create storage.buckets row + 4 RLS policies on storage.objects.
--   2. Readers / writers: anon (public read for live blog cover images);
--      authenticated admin (upload + delete via /admin/blog).
--   3. Schema_version: no contract bumped — storage.objects is Supabase-managed.
--   4. Data migration: none.
--   5. New role / policy: 4 new storage.objects policies scoped to this bucket.
--   6. Rollback: drop the policies + the bucket. Existing uploaded files
--      become orphaned in cloud storage; live posts referencing those URLs
--      404. Re-create bucket with same id to recover.
--   7. Sign-off: owner 2026-05-25.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Bucket. Public so the live blog can render image URLs without signed
--    URLs (Charlotte's blog template + Brevo email templates both expect
--    plain CDN URLs).
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'blog-media',
  'blog-media',
  true,
  10485760,  -- 10 MB ceiling per file (generous for cover images / illustrations)
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml']
)
ON CONFLICT (id) DO UPDATE SET
  public             = EXCLUDED.public,
  file_size_limit    = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 2. RLS policies on storage.objects for this bucket only.
--    Public READ + authenticated admin INSERT/UPDATE/DELETE.
-- ---------------------------------------------------------------------------

-- Public read (every visitor to switchable.org.uk needs to fetch cover images).
DROP POLICY IF EXISTS "blog-media public read" ON storage.objects;
CREATE POLICY "blog-media public read"
  ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'blog-media');

-- Authenticated admin write (Charlotte + agents holding admin tokens).
DROP POLICY IF EXISTS "blog-media admin insert" ON storage.objects;
CREATE POLICY "blog-media admin insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'blog-media'
    AND admin.is_admin()
  );

DROP POLICY IF EXISTS "blog-media admin update" ON storage.objects;
CREATE POLICY "blog-media admin update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'blog-media'
    AND admin.is_admin()
  )
  WITH CHECK (
    bucket_id = 'blog-media'
    AND admin.is_admin()
  );

DROP POLICY IF EXISTS "blog-media admin delete" ON storage.objects;
CREATE POLICY "blog-media admin delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'blog-media'
    AND admin.is_admin()
  );

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS "blog-media public read"   ON storage.objects;
-- DROP POLICY IF EXISTS "blog-media admin insert"  ON storage.objects;
-- DROP POLICY IF EXISTS "blog-media admin update"  ON storage.objects;
-- DROP POLICY IF EXISTS "blog-media admin delete"  ON storage.objects;
-- DELETE FROM storage.buckets WHERE id = 'blog-media';
-- COMMIT;
