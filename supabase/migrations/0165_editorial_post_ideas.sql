-- Migration 0165 — editorial.post_ideas (topic queue table)
-- Date:   2026-05-24
-- Author: Claude (Sasha session) with owner sign-off
-- Reason:
--   Phase 2 of the blog CMS build. `/blog-content-plan` skill (shipped by
--   Mable in S72) generates a quarterly pipeline of post topics. Today
--   those land as a markdown brief; this table is where they go next —
--   a structured queue Charlotte can draft from, mark drafted, or kill.
--
--   `/draft-blog-post` (Mable's other new skill) reads the next queued
--   row, drafts to editorial.posts as status='draft', then flips this
--   row to status='drafted' to keep the pipeline visible on
--   /admin/blog/content-plan.
--
-- Related:
--   platform/supabase/migrations/0163_editorial_schema_blog_cms.sql
--   .claude/skills/blog-content-plan/SKILL.md (seeds rows)
--   .claude/skills/draft-blog-post/SKILL.md   (consumes rows)
--   /admin/blog/content-plan (Phase 2 UI, lands later this session)
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new table editorial.post_ideas with 1 index + RLS policies.
--      No DDL on existing tables.
--   2. Readers: future /admin/blog/content-plan page, future
--      /draft-blog-post skill workflow, readonly_analytics (Mira queries
--      pipeline health weekly). All RLS-gated.
--   3. Writers: future /admin/blog/content-plan (Charlotte create/edit),
--      /blog-content-plan skill (bulk insert via service role for the
--      quarterly seed), /draft-blog-post (status flip to 'drafted').
--   4. Schema_version: per-row inherits the editorial schema convention
--      (no schema_version column at table level; the editorial UI is the
--      contract).
--   5. Data migration: none. Empty table, fills via the skill workflows.
--   6. Role / policy: SELECT to authenticated + readonly_analytics,
--      INSERT/UPDATE/DELETE gated by admin.is_admin().
--   7. Rollback: DROP TABLE editorial.post_ideas in DOWN. Safe — no
--      consumer reads from it yet.
--   8. Sign-off: owner 2026-05-24 ("go build it now").

BEGIN;

CREATE TABLE editorial.post_ideas (
  id                      BIGSERIAL PRIMARY KEY,
  slug                    TEXT UNIQUE,                  -- nullable; gets set when title is finalised
  working_title           TEXT NOT NULL,
  category_id             TEXT REFERENCES editorial.categories(id) ON DELETE SET NULL,
  primary_keyword         TEXT,
  target_keywords         TEXT[] DEFAULT '{}',
  proposed_publish_date   DATE,
  series_id               TEXT,                         -- nullable; same value across grouped posts in a series
  status                  TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'drafted', 'published', 'killed')),
  notes                   TEXT,
  sort_order              INT NOT NULL DEFAULT 0,
  created_by              UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX editorial_post_ideas_status_date_idx
  ON editorial.post_ideas (status, proposed_publish_date ASC NULLS LAST);

COMMENT ON TABLE editorial.post_ideas IS
  'Topic queue for the blog. Seeded quarterly by /blog-content-plan skill (~36 ideas per quarter across all 5 categories). /draft-blog-post pulls the next queued row, drafts to editorial.posts, flips status to drafted. /admin/blog/content-plan surfaces the pipeline. Killed rows preserved for audit (don''t delete — Charlotte may revisit).';

COMMENT ON COLUMN editorial.post_ideas.slug IS
  'Optional URL slug. NULL while in queued state. Set when /draft-blog-post creates the editorial.posts row (slug matches for traceability).';

COMMENT ON COLUMN editorial.post_ideas.series_id IS
  'Shared identifier for grouped multi-part posts (e.g. a 5-part career-switching series). NULL for standalone posts. Convention: lowercase-kebab, e.g. ''career-switch-at-40''.';

COMMENT ON COLUMN editorial.post_ideas.status IS
  'queued=in pipeline, not yet drafted. drafted=editorial.posts row exists in draft status. published=editorial.posts row is live. killed=decided not to write, kept for audit.';

-- RLS ----------------------------------------------------------------------
ALTER TABLE editorial.post_ideas ENABLE ROW LEVEL SECURITY;

CREATE POLICY readonly_analytics_select_post_ideas
  ON editorial.post_ideas FOR SELECT TO readonly_analytics USING (true);

CREATE POLICY auth_select_post_ideas
  ON editorial.post_ideas FOR SELECT TO authenticated USING (true);

CREATE POLICY admin_write_post_ideas
  ON editorial.post_ideas FOR ALL TO authenticated
  USING (admin.is_admin()) WITH CHECK (admin.is_admin());

-- Grants -------------------------------------------------------------------
GRANT SELECT ON editorial.post_ideas TO readonly_analytics;
GRANT SELECT, INSERT, UPDATE, DELETE ON editorial.post_ideas TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE editorial.post_ideas_id_seq TO authenticated;

-- updated_at trigger -------------------------------------------------------
CREATE OR REPLACE FUNCTION editorial.touch_post_ideas_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER editorial_post_ideas_touch_updated_at
  BEFORE UPDATE ON editorial.post_ideas
  FOR EACH ROW EXECUTE FUNCTION editorial.touch_post_ideas_updated_at();

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP TRIGGER  IF EXISTS editorial_post_ideas_touch_updated_at ON editorial.post_ideas;
-- DROP FUNCTION IF EXISTS editorial.touch_post_ideas_updated_at();
-- DROP TABLE    IF EXISTS editorial.post_ideas;
-- COMMIT;
