-- Migration 0027 — Fix re_submission_count to exclude waitlist-enrichments
-- Date: 2026-04-26
-- Author: Claude (platform Session D continued) with owner sign-off
-- Reason: Owner spotted that the "Reapplied N×" badge was firing on waitlist
--         parents whose only children were waitlist-enrichment submissions —
--         which aren't re-applications, they're the same submission with
--         extra details added later. Different concept.
--
--         Fix: re_submission_count counts only true re-applications. A
--         waitlist-enrichment child (dq_reason='waitlist_enrichment') is
--         linked to its parent via parent_submission_id but doesn't bump
--         the parent's count.
--
--         The dashboard's "Reapplied N×" badge then only shows on rows
--         that actually had repeat engagement, not just enrichment.
--
--         Children stay linked. Dashboard list still hides them as before
--         (parent_submission_id IS NOT NULL excludes them from the list
--         view). The only thing that changes is the counter.
--
-- Related: platform/supabase/migrations/0026_lead_dedup_v1.sql,
--          _shared/ingest.ts (going-forward logic).

-- UP

-- Recalculate re_submission_count + last_re_submission_at on every parent.
-- Counts only children that are NOT waitlist-enrichment.
-- Parents with no qualifying children get reset to 0 / NULL.

WITH child_counts AS (
  SELECT
    parent_submission_id AS parent_id,
    COUNT(*) FILTER (WHERE COALESCE(dq_reason, '') != 'waitlist_enrichment') AS qualifying_children,
    MAX(submitted_at) FILTER (WHERE COALESCE(dq_reason, '') != 'waitlist_enrichment') AS last_qualifying_at
  FROM leads.submissions
  WHERE parent_submission_id IS NOT NULL
  GROUP BY parent_submission_id
)
UPDATE leads.submissions s
   SET re_submission_count   = COALESCE(c.qualifying_children, 0),
       last_re_submission_at = c.last_qualifying_at
  FROM child_counts c
 WHERE s.id = c.parent_id;

-- Parents whose only children were enrichments (no qualifying re-applications)
-- end up with re_submission_count=0 + last_re_submission_at=NULL after the
-- UPDATE above. That's correct — the "Reapplied" badge won't fire on them.

DO $$
DECLARE
  v_real_reapps INT;
  v_zero_after INT;
BEGIN
  SELECT COUNT(*) INTO v_real_reapps FROM leads.submissions WHERE re_submission_count > 0;
  SELECT COUNT(*) INTO v_zero_after FROM leads.submissions WHERE re_submission_count = 0 AND id IN (SELECT DISTINCT parent_submission_id FROM leads.submissions WHERE parent_submission_id IS NOT NULL);
  RAISE NOTICE 'After fix: % parents have real re-applications, % parents with only enrichment children now show 0', v_real_reapps, v_zero_after;
END $$;

-- DOWN
-- -- To restore: re-run the original 0026 backfill (counts ALL children).
-- WITH child_counts AS (
--   SELECT parent_submission_id AS parent_id, COUNT(*) AS children, MAX(submitted_at) AS last_child_at
--   FROM leads.submissions WHERE parent_submission_id IS NOT NULL GROUP BY parent_submission_id
-- )
-- UPDATE leads.submissions s SET re_submission_count = c.children, last_re_submission_at = c.last_child_at
-- FROM child_counts c WHERE s.id = c.parent_id;
