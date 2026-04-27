-- Migration 0026 — Lead deduplication v1
-- Date: 2026-04-26
-- Author: Claude (platform Session D continued) with owner sign-off
-- Reason: Live evidence on 2026-04-26: Glennis Adamson submitted twice
--         (id 147 + 152), same email, same course, both auto-routed to
--         EMS. Andy now has two duplicate rows in his sheet. The waitlist
--         + waitlist-enrichment pattern produces the same dupe class for
--         DQ leads (e.g. Alistair Divers — id 137 + 138 — was an early
--         live example).
--
--         Owner framing (2026-04-26):
--           - Same lead → same provider: re-application. Engagement
--             signal. Don't duplicate the sheet row, but DO tell the
--             provider they reapplied. (V2 will append to provider's
--             sheet notes column; V1 just sends an email.)
--           - Same lead → different provider: not a duplicate. Different
--             routing event, both legitimate.
--           - Waitlist → waitlist-enrichment: enrichment should attach
--             to the parent waitlist row, not create a new submission.
--
--         This migration ships the schema for those decisions:
--
--         1. leads.submissions.parent_submission_id BIGINT REFERENCES
--            leads.submissions(id) ON DELETE RESTRICT — set when a row
--            is detected as a re-application of a recent prior submission.
--            NULL on first-time submissions.
--
--         2. leads.submissions.re_submission_count INT NOT NULL DEFAULT 0
--            — incremented on the PARENT row each time a child is created.
--            The parent's count is what the dashboard surfaces ("Reapplied
--            3 times").
--
--         3. leads.submissions.last_re_submission_at TIMESTAMPTZ — when
--            the most recent re-application of this row was detected.
--            NULL until the first re-application.
--
--         4. crm.providers.sheet_supports_reapply_op BOOLEAN DEFAULT false
--            — per-provider rollout flag for the V2 Apps Script update.
--            When true, the Edge Function sends a "reapply" op to the
--            provider's sheet on a re-application; when false, only the
--            email notification fires. Default false during V1 rollout
--            (none of the provider Apps Scripts have the v3 op yet).
--
--         5. Index on (email, course_id, submitted_at DESC) for fast
--            parent lookup during ingest.
--
--         The 14-day presumed-enrolled timer stays anchored to the
--         original `routed_at` per owner decision — re-application
--         doesn't reset the clock. Billing integrity rationale.
--
-- Related: platform/docs/auto-routing-design.md,
--          platform/docs/changelog.md (todo: add lead-dedup-v1 entry).

-- UP

-- =============================================================================
-- 1. leads.submissions: parent linking + re-application counters
-- =============================================================================

ALTER TABLE leads.submissions
  ADD COLUMN IF NOT EXISTS parent_submission_id    BIGINT REFERENCES leads.submissions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS re_submission_count     INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_re_submission_at   TIMESTAMPTZ;

COMMENT ON COLUMN leads.submissions.parent_submission_id IS
  'When this row is a re-application of a prior submission with the same email + course_id, this points to the parent row. NULL on first-time submissions. Added migration 0026.';

COMMENT ON COLUMN leads.submissions.re_submission_count IS
  'Number of times this lead has been re-applied (this row is the parent). Incremented when a child is created. Surface in dashboard as "Reapplied N times". Added migration 0026.';

COMMENT ON COLUMN leads.submissions.last_re_submission_at IS
  'Timestamp of the most recent child submission. NULL until first re-application. Added migration 0026.';

-- Fast parent lookup: same email + same course, most recent first
CREATE INDEX IF NOT EXISTS submissions_email_course_lookup_idx
  ON leads.submissions (email, course_id, submitted_at DESC)
  WHERE email IS NOT NULL AND archived_at IS NULL;

-- =============================================================================
-- 2. crm.providers: per-provider sheet-update flag
-- =============================================================================

ALTER TABLE crm.providers
  ADD COLUMN IF NOT EXISTS sheet_supports_reapply_op BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN crm.providers.sheet_supports_reapply_op IS
  'Provider Apps Script supports the v3 reapply op (find row by email, append to notes column). Default false during V1 rollout — Edge Function only sends email notification on re-applications until each providers Apps Script gets the v3 update. Added migration 0026.';

-- =============================================================================
-- 3. Backfill historical re-applications
-- =============================================================================
-- Rules:
--   - Only consider non-archived rows
--   - Match by email + course_id (case-insensitive on email)
--   - Within each match group, oldest is the parent, newer ones are children
--   - Skip groups with only one member (no re-application)
--
-- Updates parent rows: set re_submission_count + last_re_submission_at
-- Updates child rows:  set parent_submission_id

WITH ranked AS (
  SELECT
    id,
    submitted_at,
    LOWER(email) AS lower_email,
    course_id,
    ROW_NUMBER() OVER (PARTITION BY LOWER(email), course_id ORDER BY submitted_at ASC) AS rank_in_group,
    COUNT(*) OVER (PARTITION BY LOWER(email), course_id) AS group_size,
    FIRST_VALUE(id) OVER (PARTITION BY LOWER(email), course_id ORDER BY submitted_at ASC) AS parent_id
  FROM leads.submissions
  WHERE email IS NOT NULL
    AND archived_at IS NULL
)
UPDATE leads.submissions s
   SET parent_submission_id = r.parent_id
  FROM ranked r
 WHERE s.id = r.id
   AND r.rank_in_group > 1   -- only children get parent_submission_id
   AND r.group_size > 1;

-- Set re_submission_count + last_re_submission_at on parents
WITH child_counts AS (
  SELECT
    parent_submission_id AS parent_id,
    COUNT(*) AS children,
    MAX(submitted_at) AS last_child_at
  FROM leads.submissions
  WHERE parent_submission_id IS NOT NULL
  GROUP BY parent_submission_id
)
UPDATE leads.submissions s
   SET re_submission_count   = c.children,
       last_re_submission_at = c.last_child_at
  FROM child_counts c
 WHERE s.id = c.parent_id;

-- =============================================================================
-- 4. Verification
-- =============================================================================
-- Quick sanity check that the backfill matched expected dupes.
DO $$
DECLARE
  v_dupes_with_parent INT;
  v_parents INT;
BEGIN
  SELECT COUNT(*) INTO v_dupes_with_parent FROM leads.submissions WHERE parent_submission_id IS NOT NULL;
  SELECT COUNT(*) INTO v_parents FROM leads.submissions WHERE re_submission_count > 0;
  RAISE NOTICE 'Backfill: % child rows linked to % parent rows', v_dupes_with_parent, v_parents;
END $$;

-- DOWN
-- ALTER TABLE crm.providers DROP COLUMN IF EXISTS sheet_supports_reapply_op;
-- DROP INDEX IF EXISTS leads.submissions_email_course_lookup_idx;
-- ALTER TABLE leads.submissions
--   DROP COLUMN IF EXISTS last_re_submission_at,
--   DROP COLUMN IF EXISTS re_submission_count,
--   DROP COLUMN IF EXISTS parent_submission_id;
