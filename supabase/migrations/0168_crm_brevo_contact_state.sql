-- Migration 0168 — crm.brevo_contact_state for SW_PENDING_RESTART flip detection
-- Date: 2026-05-25
-- Author: Claude (Sasha, platform session) with owner sign-off
-- Reason:
--   Wren push (broadcast-gating 2026-05-25). New Brevo attribute
--   SW_PENDING_RESTART signals "this contact's canonical course just flipped"
--   so Brevo N1-N3 automations can re-trigger the welcome sequence for
--   re-applicants. Course-agnostic — works for any future cross-course
--   campaign without per-campaign automation logic.
--
--   This table holds the per-email "last canonical course we pushed to Brevo".
--   The upsertLearnerInBrevo path reads it before the upsert to detect a
--   flip, then UPSERTs the new value after the Brevo write succeeds. Living
--   in our own DB (vs read-back from Brevo per lead) saves a per-lead API
--   call and survives Brevo outages.
--
--   First-time contacts have no row → no flip detected (Wren spec: "first-time
--   leads leave it untouched"). Same-course re-submit → no flip. Different
--   course → flip detected → SW_PENDING_RESTART=true pushed on the upsert.
--   The N1-N3 automation step resets the flag back to false on restart so
--   the next flip retriggers cleanly.
--
-- Related:
--   platform/supabase/functions/_shared/route-lead.ts (writer)
--   platform/docs/current-handoff.md item 23 (Wren push spec)
--   switchable/email/CLAUDE.md (Brevo-side automation setup, Wren owns)
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new table crm.brevo_contact_state with PK on email_lower.
--   2. Readers / writers: functions_writer reads + writes (route-lead.ts
--      Edge Function code). readonly_analytics gets SELECT for agent MCP
--      visibility. No other consumers.
--   3. Schema_version: no contract bumped — this is internal state.
--   4. Data migration: none. Empty on apply. Populates organically as new
--      submissions come in. Existing contacts get a row on their next
--      Brevo upsert (any new submission, fastrack, enrolment status change).
--   5. New role / policy: none (uses existing functions_writer / readonly_analytics).
--   6. Rollback: DROP TABLE in DOWN. SW_PENDING_RESTART attribute on the
--      Brevo side stays harmless (never flips without a backing DB row).
--   7. Sign-off: owner 2026-05-25.

BEGIN;

CREATE TABLE crm.brevo_contact_state (
  -- Lowercased email is the natural key — Brevo treats contact emails
  -- case-insensitively. Matches the lower(email) pattern used everywhere
  -- in leads.submissions reads.
  email_lower              TEXT PRIMARY KEY,
  -- The course_id from the canonical submission at the moment of the last
  -- successful Brevo upsert. NULL when no canonical course (DQ-only history).
  last_canonical_course_id TEXT,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE crm.brevo_contact_state IS
  'Per-email "last canonical course we pushed to Brevo". Drives SW_PENDING_RESTART flip detection in route-lead.ts. One row per Brevo contact. UPSERTed after every successful Brevo upsert on the matched + no_match paths.';

COMMENT ON COLUMN crm.brevo_contact_state.last_canonical_course_id IS
  'course_id of the canonical submission (latest opt-in OR latest archived-not row) at the moment of the most recent Brevo upsert. Compared against the new canonical on the next upsert; mismatch triggers SW_PENDING_RESTART=true.';

-- updated_at index supports "recently flipped" diagnostic queries.
CREATE INDEX brevo_contact_state_updated_at_idx
  ON crm.brevo_contact_state (updated_at DESC);

-- Grants. Edge Function code runs as functions_writer (per the SUPABASE_DB_URL
-- pattern). Agents read via readonly_analytics MCP.
GRANT USAGE ON SCHEMA crm TO functions_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm.brevo_contact_state TO functions_writer;
GRANT SELECT ON crm.brevo_contact_state TO readonly_analytics;

ALTER TABLE crm.brevo_contact_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "functions_writer full access"
  ON crm.brevo_contact_state
  FOR ALL
  TO functions_writer
  USING (true)
  WITH CHECK (true);

CREATE POLICY "readonly_analytics select"
  ON crm.brevo_contact_state
  FOR SELECT
  TO readonly_analytics
  USING (true);

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP TABLE IF EXISTS crm.brevo_contact_state;
-- COMMIT;
