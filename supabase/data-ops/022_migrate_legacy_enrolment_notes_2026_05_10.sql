-- Data-op 022 — copy legacy crm.enrolments.notes into crm.lead_notes as system rows
-- Date:    2026-05-10
-- Author:  Claude (platform Session 39) on Charlotte's instruction
-- Purpose: Session 39's AdminNotesPanel introduced crm.lead_notes as the
--          new append-only log. The legacy single-blob crm.enrolments.notes
--          column carried 74 rows of admin-typed notes from earlier
--          sessions. Two notes mechanisms on the same admin page is
--          confusing UX — surfacing the legacy text inside the new log
--          (as system-authored, dated to the enrolment row's last
--          status_updated_at) lets us drop the duplicate textarea
--          without losing data.
--
--          Idempotent. Safe to re-run.
--
-- Rules:
--   - Only enrolments where notes is non-empty are migrated.
--   - Only enrolments whose primary_routed_to is non-null AND not a demo
--     provider's id (demo seeded notes don't need a copy in the log).
--   - author_role='system'; author_display_name='Earlier admin note';
--     author_user_id NULL because we don't know the original author.
--   - created_at = enrolments.status_updated_at (best approximation of
--     when the note was written).
--   - Skipped if a system row with identical body already exists for
--     the same submission_id (idempotency on body match).

BEGIN;

WITH eligible AS (
  SELECT
    e.submission_id,
    e.notes,
    e.status_updated_at,
    s.primary_routed_to
  FROM crm.enrolments e
  JOIN leads.submissions s ON s.id = e.submission_id
  JOIN crm.providers p ON p.provider_id = s.primary_routed_to
  WHERE e.notes IS NOT NULL
    AND length(trim(e.notes)) > 0
    AND s.primary_routed_to IS NOT NULL
    AND p.is_demo = false
),
to_insert AS (
  SELECT *
  FROM eligible elg
  WHERE NOT EXISTS (
    SELECT 1 FROM crm.lead_notes ln
    WHERE ln.submission_id = elg.submission_id
      AND ln.author_role = 'system'
      AND ln.body = elg.notes
  )
)
INSERT INTO crm.lead_notes (
  submission_id, provider_id, provider_user_id,
  author_role, author_user_id, author_display_name,
  body, created_at
)
SELECT
  submission_id,
  primary_routed_to,
  NULL,
  'system',
  NULL,
  'Earlier admin note',
  notes,
  status_updated_at
FROM to_insert;

-- Report
SELECT
  (SELECT count(*) FROM crm.lead_notes WHERE author_role = 'system' AND author_display_name = 'Earlier admin note') AS migrated_total,
  (SELECT count(DISTINCT submission_id) FROM crm.lead_notes WHERE author_role = 'system' AND author_display_name = 'Earlier admin note') AS distinct_leads_covered;

COMMIT;
