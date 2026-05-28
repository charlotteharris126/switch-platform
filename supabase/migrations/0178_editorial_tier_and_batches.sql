-- Migration 0178 — editorial.post_ideas.tier + editorial.draft_batches
-- Date: 2026-05-28
-- Author: Claude (Sasha, platform session) with owner sign-off
-- Reason:
--   The agentified blog drafter (Build 4) classifies each topic queue row
--   into one of three tiers per .claude/rules/editorial-rules.md:
--     A = single bespoke post (one master draft, no variants)
--     B = cluster of variants (one master draft + N fan-outs across a
--         variable axis like town / demographic / job)
--     C = service page (programmatic, no AI; handled by
--         scripts/build-funded-pages.js — recorded here for completeness
--         but C rows are usually created by Mira-curated regional data,
--         not by the queue)
--
--   This migration:
--     1. Adds `tier` + `variants` + `variant_axis` columns on post_ideas
--     2. Creates editorial.draft_batches to group a master + variant
--        drafts so Charlotte can spot-check the master + 2 randoms and
--        approve the whole batch with one click
--
-- Related:
--   - .claude/rules/editorial-rules.md (the rules these columns enforce)
--   - platform/supabase/functions/blog-draft-from-queue/ (the drafter EF)
--   - platform/app/app/admin/blog/content-plan/ (Charlotte's queue admin UI)
--
-- Impact assessment:
--   1. Change: 3 additive columns on post_ideas; new table draft_batches
--      with 4 RLS policies + 2 indexes.
--   2. Readers: drafter EF, admin content-plan view, /blog-content-plan
--      skill output.
--   3. Schema_version: no payload bumped.
--   4. Data migration: existing post_ideas rows default to tier='A'.
--   5. Rollback: see DOWN.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Tier classification on post_ideas.
-- ---------------------------------------------------------------------------

ALTER TABLE editorial.post_ideas
  ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'A'
  CHECK (tier IN ('A', 'B', 'C'));

COMMENT ON COLUMN editorial.post_ideas.tier IS
  'A = single bespoke post (1 draft). B = cluster of variants (1 master + N fan-outs over `variants` axis). C = service page (programmatic, build-script only). See .claude/rules/editorial-rules.md §2.';

-- Variant axis describes WHAT varies (town / demographic / job / region).
-- Free-text so Mira can describe new axes without schema changes.
ALTER TABLE editorial.post_ideas
  ADD COLUMN IF NOT EXISTS variant_axis TEXT;

COMMENT ON COLUMN editorial.post_ideas.variant_axis IS
  'For tier=B only. Describes the axis (e.g. "town", "demographic", "job"). The drafter substitutes each entry from `variants` into the master template.';

-- Variants is the actual list of values. e.g. for axis=town:
-- ['middlesbrough', 'hartlepool', 'stockton-on-tees'].
ALTER TABLE editorial.post_ideas
  ADD COLUMN IF NOT EXISTS variants TEXT[] DEFAULT '{}';

COMMENT ON COLUMN editorial.post_ideas.variants IS
  'For tier=B only. The list of values the master template fans out over. Length = number of posts the cluster generates. Empty for tier=A and tier=C.';

-- ---------------------------------------------------------------------------
-- 2. Draft batches table.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS editorial.draft_batches (
  id              BIGSERIAL PRIMARY KEY,
  post_idea_id    BIGINT NOT NULL REFERENCES editorial.post_ideas(id) ON DELETE CASCADE,
  tier            TEXT NOT NULL CHECK (tier IN ('A', 'B')),
  master_post_id  BIGINT REFERENCES editorial.posts(id) ON DELETE SET NULL,
  variant_post_ids BIGINT[] DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'drafting'
    CHECK (status IN ('drafting', 'awaiting_proof', 'approved', 'rejected')),
  total_count     INT NOT NULL DEFAULT 1,
  drafted_count   INT NOT NULL DEFAULT 0,
  failed_count    INT NOT NULL DEFAULT 0,
  error_log       JSONB DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS draft_batches_status_idx
  ON editorial.draft_batches (status, created_at DESC);
CREATE INDEX IF NOT EXISTS draft_batches_idea_idx
  ON editorial.draft_batches (post_idea_id);

COMMENT ON TABLE editorial.draft_batches IS
  'Groups a master draft + N variant drafts so Charlotte can approve a Tier B cluster with one action. status: drafting=in flight; awaiting_proof=all variants in DB as drafts; approved=Charlotte signed off (all variants flipped to status=scheduled or published); rejected=killed (all variants archived).';

-- RLS — admin read + write, readonly_analytics read.
ALTER TABLE editorial.draft_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_read_draft_batches ON editorial.draft_batches;
CREATE POLICY admin_read_draft_batches
  ON editorial.draft_batches FOR SELECT
  TO authenticated
  USING (admin.is_admin());

DROP POLICY IF EXISTS admin_write_draft_batches ON editorial.draft_batches;
CREATE POLICY admin_write_draft_batches
  ON editorial.draft_batches FOR ALL
  TO authenticated
  USING (admin.is_admin())
  WITH CHECK (admin.is_admin());

DROP POLICY IF EXISTS readonly_select_draft_batches ON editorial.draft_batches;
CREATE POLICY readonly_select_draft_batches
  ON editorial.draft_batches FOR SELECT
  TO readonly_analytics
  USING (TRUE);

-- The drafter EF runs as service_role via the Postgres connection string,
-- which bypasses RLS — no explicit policy needed for it.

GRANT SELECT, INSERT, UPDATE ON editorial.draft_batches TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE editorial.draft_batches_id_seq TO authenticated;
GRANT SELECT ON editorial.draft_batches TO readonly_analytics;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
--   DROP TABLE IF EXISTS editorial.draft_batches;
--   ALTER TABLE editorial.post_ideas DROP COLUMN IF EXISTS variants;
--   ALTER TABLE editorial.post_ideas DROP COLUMN IF EXISTS variant_axis;
--   ALTER TABLE editorial.post_ideas DROP COLUMN IF EXISTS tier;
-- COMMIT;
