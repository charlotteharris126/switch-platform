-- Migration 0163 — editorial schema for blog CMS
-- Date:   2026-05-24
-- Author: Claude (Mable session, cross-project to platform) with owner sign-off
-- Reason:
--   Charlotte's plan for the blog has Claude drafting + Charlotte editing 1
--   post per week ongoing. Today that workflow is YAML-file-on-disk. That
--   doesn't scale (no UI, no media management, no tag dedup with retroactive
--   apply, no per-field SEO management, no preview workflow, no auth gating).
--
--   This migration ships the foundation for a proper CMS admin: an
--   `editorial` schema with posts, tags, categories, media and a junction
--   table for post-to-tag. The build script and admin pages land in
--   subsequent sessions (Sasha's domain) — this migration is just the
--   shape Charlotte's UI will write into, the build script will read from.
--
--   Categories are seeded inline from data/post-categories.yml (5 rows).
--   Tags are seeded from data/blog-tags.yml (16 rows). Posts are NOT seeded
--   here — they ship via data-ops next session once Sasha has the admin
--   pages ready to write into the table (no point seeding posts before
--   anything reads them).
--
--   Build script flip from YAML→DB is the work in a separate session. For
--   now both data sources can coexist: the YAML files remain canonical
--   until Sasha's admin pages + the DB-reading build script ship.
--
-- Related:
--   switchable/site/deploy/data/post-categories.yml (mirror, drift-checked)
--   switchable/site/deploy/data/blog-tags.yml (mirror, drift-checked)
--   switchable/site/deploy/data/posts/*.yml (4 drafts, will migrate)
--   switchable/site/deploy/scripts/build-blog-posts.js (reads YAML today;
--     reads DB after Sasha's admin lands)
--   Planned: /admin/blog/new, /admin/blog/[slug]/edit, /admin/blog/tags,
--     /admin/blog/media (Sasha next session)
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new schema `editorial` with 5 tables + indexes + RLS
--      policies + 2 seed UPSERTs. No DDL on existing schemas.
--   2. Readers: none today. Admin pages + DB-reading build script land
--      next session. readonly_analytics will inherit SELECT via the schema
--      grant added below.
--   3. Writers: none today. admin (Charlotte) writes via the future admin
--      pages, gated by admin.is_admin() in RLS.
--   4. Schema_version: editorial.posts is a new data contract with the
--      eventual admin UI. Versioning is per-row via the schema_version
--      column rather than table-wide (matches leads.submissions pattern).
--   5. Data migration: none in this migration. Existing YAML posts get
--      ported via a data-ops script next session when admin can read them.
--   6. Role / policy: editorial schema SELECT granted to authenticated +
--      readonly_analytics. INSERT/UPDATE/DELETE gated by admin.is_admin()
--      in per-table RLS.
--   7. Rollback: DROP SCHEMA editorial CASCADE in DOWN. Safe at any point
--      because no consumer reads from these tables yet.
--   8. Sign-off: owner 2026-05-24.

BEGIN;

CREATE SCHEMA IF NOT EXISTS editorial;

-- ── Categories ─────────────────────────────────────────────────────────────
-- Mirrors data/post-categories.yml. 5 rows seeded inline. Charlotte edits
-- via /admin/blog/categories (future) or directly here for now.

CREATE TABLE editorial.categories (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  accent_colour     TEXT,
  primary_keywords  TEXT[] DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE editorial.categories IS
  'Blog post categories. One row per top-level category (career-switching, money, etc.). Mirrors switchable/site/deploy/data/post-categories.yml until the build script flips to read from this table.';

-- ── Tags ────────────────────────────────────────────────────────────────────
-- Mirrors data/blog-tags.yml. Universal tag registry. The CMS admin will let
-- Charlotte create a new tag inline AND surface a checklist of older posts
-- to retroactively apply it to (her spec from 2026-05-24).

CREATE TABLE editorial.tags (
  id           BIGSERIAL PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE editorial.tags IS
  'Universal blog tag registry. Tags are cross-cutting (skills-bootcamps, pensions, eligibility). Each post can carry multiple tags via editorial.post_tags. Mirrors switchable/site/deploy/data/blog-tags.yml until build flip.';

-- ── Posts ───────────────────────────────────────────────────────────────────
-- The core CMS table. Carries everything Charlotte spec''d:
--   - copy (body)
--   - title, dek, excerpt
--   - cover_image_url + cover_image_alt
--   - category_id
--   - status workflow (draft / scheduled / published / archived)
--   - SEO fields (meta_title, meta_description, og_title/description/image,
--     canonical_url, target_keywords)
--   - end_cta JSONB (type + course_id or other params)
--   - lead_magnet_enabled
--   - featured flag (drives the /blog/ featured-post slot)
--   - reading_time_minutes (computed by admin on save, override-able)
--   - author_id (auth.users — admin who wrote/edited)

CREATE TABLE editorial.posts (
  id                    BIGSERIAL PRIMARY KEY,
  schema_version        TEXT NOT NULL DEFAULT '1.0',
  slug                  TEXT NOT NULL UNIQUE,
  title                 TEXT NOT NULL,
  dek                   TEXT,
  excerpt               TEXT,
  body                  TEXT NOT NULL DEFAULT '',
  category_id           TEXT REFERENCES editorial.categories(id) ON DELETE SET NULL,
  status                TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'published', 'archived')),
  publish_date          DATE,
  last_modified         TIMESTAMPTZ NOT NULL DEFAULT now(),
  reading_time_minutes  INT,
  cover_image_url       TEXT,
  cover_image_alt       TEXT,
  featured              BOOLEAN NOT NULL DEFAULT false,
  lead_magnet_enabled   BOOLEAN NOT NULL DEFAULT true,
  -- SEO
  meta_title            TEXT,
  meta_description      TEXT,
  og_title              TEXT,
  og_description        TEXT,
  og_image_url          TEXT,
  canonical_url         TEXT,
  target_keywords       TEXT[] DEFAULT '{}',
  -- Internal
  internal_links        TEXT[] DEFAULT '{}',
  related_courses       TEXT[] DEFAULT '{}',
  end_cta               JSONB DEFAULT '{"type": "course-finder"}'::jsonb,
  -- Audit
  author_id             UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX editorial_posts_status_publish_date_idx
  ON editorial.posts (status, publish_date DESC);
CREATE INDEX editorial_posts_category_idx ON editorial.posts (category_id);
CREATE INDEX editorial_posts_featured_idx ON editorial.posts (featured) WHERE featured = true;

COMMENT ON TABLE editorial.posts IS
  'Blog posts. Single source of truth for body, metadata, SEO, status, scheduling, end_cta. The build script reads from here (next session) to generate the static HTML at /blog/<slug>/. Authoring happens via /admin/blog/* pages (next session) gated by admin.is_admin().';

-- ── Post ↔ Tag junction ─────────────────────────────────────────────────────

CREATE TABLE editorial.post_tags (
  post_id  BIGINT NOT NULL REFERENCES editorial.posts(id) ON DELETE CASCADE,
  tag_id   BIGINT NOT NULL REFERENCES editorial.tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, tag_id)
);

CREATE INDEX editorial_post_tags_tag_idx ON editorial.post_tags (tag_id);

COMMENT ON TABLE editorial.post_tags IS
  'Many-to-many junction between editorial.posts and editorial.tags. Charlotte''s "create new tag + apply retroactively to older posts" UI writes into this table after letting her tick which posts to apply the new tag to.';

-- ── Media ──────────────────────────────────────────────────────────────────
-- Uploaded blog assets (covers, inline images). Files live in Supabase
-- Storage; this table tracks the metadata + URL. The /admin/blog/media
-- page (future) gives Charlotte a library view + upload flow.

CREATE TABLE editorial.media (
  id           BIGSERIAL PRIMARY KEY,
  url          TEXT NOT NULL,
  alt          TEXT,
  width        INT,
  height       INT,
  mime_type    TEXT,
  filename     TEXT,
  byte_size    BIGINT,
  uploaded_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE editorial.media IS
  'Uploaded blog media (cover images, inline article images). Storage in a Supabase Storage bucket; this table is the metadata + URL index. Cover image picker on /admin/blog/[slug]/edit reads from here.';

-- ── Grants + RLS ───────────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA editorial TO authenticated, readonly_analytics;
GRANT SELECT ON ALL TABLES IN SCHEMA editorial TO readonly_analytics;
GRANT SELECT ON ALL TABLES IN SCHEMA editorial TO authenticated;
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA editorial TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA editorial TO authenticated;

ALTER TABLE editorial.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE editorial.tags       ENABLE ROW LEVEL SECURITY;
ALTER TABLE editorial.posts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE editorial.post_tags  ENABLE ROW LEVEL SECURITY;
ALTER TABLE editorial.media      ENABLE ROW LEVEL SECURITY;

-- readonly_analytics: SELECT anything (Iris, Mira, Metabase, agent MCPs)
CREATE POLICY readonly_analytics_select_categories
  ON editorial.categories FOR SELECT TO readonly_analytics USING (true);
CREATE POLICY readonly_analytics_select_tags
  ON editorial.tags FOR SELECT TO readonly_analytics USING (true);
CREATE POLICY readonly_analytics_select_posts
  ON editorial.posts FOR SELECT TO readonly_analytics USING (true);
CREATE POLICY readonly_analytics_select_post_tags
  ON editorial.post_tags FOR SELECT TO readonly_analytics USING (true);
CREATE POLICY readonly_analytics_select_media
  ON editorial.media FOR SELECT TO readonly_analytics USING (true);

-- authenticated: SELECT published posts only (for any future logged-in user
-- preview). Admin-gated rows (drafts + archived) require admin.is_admin().
CREATE POLICY auth_select_categories
  ON editorial.categories FOR SELECT TO authenticated USING (true);
CREATE POLICY auth_select_tags
  ON editorial.tags FOR SELECT TO authenticated USING (true);
CREATE POLICY auth_select_posts
  ON editorial.posts FOR SELECT TO authenticated
  USING (status = 'published' OR admin.is_admin());
CREATE POLICY auth_select_post_tags
  ON editorial.post_tags FOR SELECT TO authenticated USING (true);
CREATE POLICY auth_select_media
  ON editorial.media FOR SELECT TO authenticated USING (true);

-- admin: full write access (gated via admin.is_admin())
CREATE POLICY admin_write_categories
  ON editorial.categories FOR ALL TO authenticated
  USING (admin.is_admin()) WITH CHECK (admin.is_admin());
CREATE POLICY admin_write_tags
  ON editorial.tags FOR ALL TO authenticated
  USING (admin.is_admin()) WITH CHECK (admin.is_admin());
CREATE POLICY admin_write_posts
  ON editorial.posts FOR ALL TO authenticated
  USING (admin.is_admin()) WITH CHECK (admin.is_admin());
CREATE POLICY admin_write_post_tags
  ON editorial.post_tags FOR ALL TO authenticated
  USING (admin.is_admin()) WITH CHECK (admin.is_admin());
CREATE POLICY admin_write_media
  ON editorial.media FOR ALL TO authenticated
  USING (admin.is_admin()) WITH CHECK (admin.is_admin());

-- ── Seed: categories ──────────────────────────────────────────────────────
INSERT INTO editorial.categories (id, name, description, accent_colour, primary_keywords) VALUES
  ('career-switching',    'Career switching',    'UK guides for adults thinking about an industry change, returning to work, or a mid-life pivot. Funded routes, eligibility, route maps.', '#E76F51', ARRAY['change career UK','career change at 40','how to change careers']),
  ('starting-a-business', 'Starting a business', 'UK guides for adults starting a business, going self-employed, or testing a side hustle. Funded routes, credentials, first-year mechanics.', '#E9C46A', ARRAY['start a business UK','become self-employed','side hustle ideas UK']),
  ('upskilling',          'Upskilling',          'UK guides on funded training, certifications, and what to learn next. Skills Bootcamps, Free Courses for Jobs, Advanced Learner Loans, apprenticeships.', '#2A9D8F', ARRAY['funded training UK','free courses for jobs','online courses UK']),
  ('career-growth',       'Career growth',       'UK guides on promotions, leadership skills, and climbing in your current role. When to ask for more, when to look elsewhere, what employers actually look for.', '#287271', ARRAY['how to get promoted','leadership skills','management training UK']),
  ('money',               'Money',               'UK guides on savings, pensions, investments and money planning around a career change. Free tools, real numbers, the questions most career-change articles skip.', '#8AB17D', ARRAY['early retirement UK','pension consolidation','savings tips UK'])
ON CONFLICT (id) DO NOTHING;

-- ── Seed: tags ────────────────────────────────────────────────────────────
INSERT INTO editorial.tags (slug, name, description) VALUES
  ('free-courses-for-jobs',  'Free Courses for Jobs',  'The FCFJ scheme that funds a first Level 3 qualification for adults 24+.'),
  ('skills-bootcamps',       'Skills Bootcamps',       'DfE-funded 12-16 week intensives, mostly tech and trades.'),
  ('advanced-learner-loans', 'Advanced Learner Loans', 'Government-backed loans for Level 3-6 with no repayments until you earn over £25k.'),
  ('apprenticeships',        'Apprenticeships',        'Levy-funded training routes for any age over 16, including adult upskilling.'),
  ('uk-funding',             'UK funding',             'General UK-government funding for adult training and education.'),
  ('mid-life-career',        'Mid-life career',        'Career change in your 40s and 50s.'),
  ('career-change',          'Career change',          'Posts about switching careers across any stage.'),
  ('self-employment',        'Self-employment',        'Going from employed to self-employed, sole trader, freelance.'),
  ('pensions',               'Pensions',               'UK pension schemes, consolidation, tax relief, planning.'),
  ('savings',                'Savings',                'Building a buffer, emergency funds, planning for a career change.'),
  ('money-planning',         'Money planning',         'The financial side of career change and life transitions.'),
  ('eligibility',            'Eligibility',            'Who qualifies for what, the rules that catch people out.'),
  ('hmrc',                   'HMRC',                   'Tax, Self Assessment, registering as self-employed, UTR.'),
  ('business-banking',       'Business banking',       'Opening a business bank account, separating finances, payment processing.'),
  ('level-3-business',       'Level 3 business',       'Business qualifications at Level 3, including SFEDI and BTEC routes.'),
  ('hidden-demand',          'Hidden demand',          'The 81% of eligible UK adults who don''t know funded training exists.')
ON CONFLICT (slug) DO NOTHING;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP SCHEMA editorial CASCADE;
-- COMMIT;
