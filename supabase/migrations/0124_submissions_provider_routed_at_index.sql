-- Migration 0124 — index supporting the per-provider siblings query
-- Date: 2026-05-11
-- Author: Claude (Sasha session)
-- Reason:
--   The provider lead-detail page (/provider/leads/[id]) builds prev/next
--   navigation by fetching all the provider's routed leads ordered by
--   routed_at desc. The query is now correctly scoped via .eq() on
--   primary_routed_to (perf pass this session), but the table has no
--   matching composite index. With 200+ leads per provider already and
--   growing, a B-tree index on (primary_routed_to, routed_at DESC) makes
--   the lookup O(log n) instead of a partial-RLS-filtered scan.
--
-- Impact assessment:
--   1. Change: CREATE INDEX. No DDL effect on rows.
--   2. Readers: speeds up /provider/leads/[id], /provider/leads,
--      /admin/preview/[id]/leads/[lead_id], all admin per-provider views.
--   3. Writers: very small write-amplification cost on insert/update of
--      primary_routed_to or routed_at — negligible at our volume.
--   4. Rollback: DROP INDEX.
--   5. Sign-off: owner pending.

BEGIN;

CREATE INDEX IF NOT EXISTS submissions_provider_routed_idx
  ON leads.submissions (primary_routed_to, routed_at DESC)
  WHERE archived_at IS NULL AND parent_submission_id IS NULL;

COMMIT;

-- DOWN
-- BEGIN;
-- DROP INDEX IF EXISTS leads.submissions_provider_routed_idx;
-- COMMIT;
