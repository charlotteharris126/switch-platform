-- Migration 0109 — crm.lead_notes: append-only per-lead provider note log
-- Date:    2026-05-10
-- Author:  Claude (platform Session 39) on Charlotte's instruction
-- Reason:  The existing "notes" approach was a single TEXT column on
--          crm.enrolments, edited in place. Charlotte wants a log shape
--          instead: many notes per lead, newest first, each timestamped,
--          attributed to a specific provider user. The right-hand panel
--          on the lead detail page renders this log.
--
--          One row per note. Append-only from the portal; admin can
--          edit/delete via the admin surface if needed (admin policy
--          covers full ALL).
--
--          Audit: every INSERT also lands an audit.actions row via the
--          Server Action wrapper, so the audit chain has an independent
--          trail of who-wrote-what-when alongside the data table.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new table + 5 RLS policies + 2 indexes + GRANT.
--   2. Readers: new lead detail page right-panel (this session).
--      Future readers: admin "lead activity" panel; possibly Brevo for
--      "your notes from last call" reminders (not now).
--   3. Writers: new addLeadNoteAction Server Action (this session).
--   4. Schema version: not affected.
--   5. Data migration: none. Existing crm.enrolments.notes column kept
--      for now (legacy single-blob notes from earlier sessions); it can
--      be retired once we backfill into lead_notes. Not gating EMS.
--   6. Role/policy: provider_insert + provider_read scoped to caller's
--      provider via crm.provider_user_provider_id(). Mirrors disputes
--      pattern from 0096.
--   7. Rollback: DROP TABLE cascades the policies. lead_notes has no
--      external dependents until the new UI ships.
--   8. Sign-off: owner (this session, 2026-05-10).
-- Related: 0095/0096 (audit + RLS pattern), 0108 (the GRANT pattern).

-- UP

CREATE TABLE crm.lead_notes (
  id BIGSERIAL PRIMARY KEY,
  submission_id BIGINT NOT NULL REFERENCES leads.submissions(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES crm.providers(provider_id),
  provider_user_id BIGINT NOT NULL REFERENCES crm.provider_users(id),
  body TEXT NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX lead_notes_submission_idx ON crm.lead_notes(submission_id, created_at DESC);
CREATE INDEX lead_notes_provider_idx ON crm.lead_notes(provider_id, created_at DESC);

COMMENT ON TABLE crm.lead_notes IS
  'Append-only log of provider notes against a routed lead. Replaces the single-blob crm.enrolments.notes column for portal-driven note-taking. Each row is a discrete note with author + timestamp.';

ALTER TABLE crm.lead_notes ENABLE ROW LEVEL SECURITY;

-- Admin: full ALL via authenticated + admin.is_admin() gate.
CREATE POLICY admin_all_lead_notes
  ON crm.lead_notes
  FOR ALL TO authenticated
  USING (admin.is_admin())
  WITH CHECK (admin.is_admin());

-- Analytics readonly.
CREATE POLICY analytics_read_lead_notes
  ON crm.lead_notes
  FOR SELECT TO readonly_analytics
  USING (true);

-- Service role / functions.
CREATE POLICY functions_all_lead_notes
  ON crm.lead_notes
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- Provider read: own provider's notes, scoped by provider_id.
CREATE POLICY provider_read_lead_notes
  ON crm.lead_notes
  FOR SELECT TO authenticated
  USING (provider_id = crm.provider_user_provider_id());

-- Provider insert: must set provider_id to caller's own provider, AND
-- the submission must be routed to that provider. Server Action sets
-- provider_id server-side from the caller's pu row to keep this clean.
CREATE POLICY provider_insert_lead_notes
  ON crm.lead_notes
  FOR INSERT TO authenticated
  WITH CHECK (
    provider_id = crm.provider_user_provider_id()
    AND submission_id IN (
      SELECT id FROM leads.submissions
      WHERE primary_routed_to = crm.provider_user_provider_id()
    )
  );

-- Table-level GRANTs: SELECT + INSERT for authenticated. UPDATE/DELETE
-- intentionally not granted — notes are append-only from the portal.
GRANT SELECT, INSERT ON crm.lead_notes TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE crm.lead_notes_id_seq TO authenticated;

-- DOWN
-- REVOKE USAGE, SELECT ON SEQUENCE crm.lead_notes_id_seq FROM authenticated;
-- REVOKE SELECT, INSERT ON crm.lead_notes FROM authenticated;
-- DROP TABLE crm.lead_notes;
