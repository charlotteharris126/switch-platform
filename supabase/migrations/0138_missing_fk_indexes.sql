-- Migration 0138 — add missing FK indexes across crm.*, leads.*, audit.*
-- Date:   2026-05-12
-- Author: Claude (Sasha) with owner review
-- Reason:
--   Audit on 2026-05-12 found 19 foreign keys with no supporting index. At
--   pilot volume the seq scans they trigger are sub-millisecond, but they
--   compound badly under multi-user multi-provider load. The provider portal
--   in particular fans out queries by provider_user_id / submission_id /
--   enrolment_id, and crm.sheet_edits_log was already showing 57.6% sequential
--   scans on 191 rows in pg_stat_user_tables.
--
--   All indexes are additive, btree, named per Supabase convention
--   (<table>_<column>_idx). No data migration, no rollback risk beyond
--   `DROP INDEX` should we ever need to undo. Indexes built non-concurrently
--   because every affected table is < 5k rows; lock window is sub-second.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Adds 19 btree indexes.
--   2. Reads: every query joining on these columns gets a faster plan. No
--      query is broken by adding an index.
--   3. Writes: tiny write-amplification on INSERT/UPDATE (one btree update
--      per index). At pilot insert rates, immeasurable.
--   4. schema_version: no bump (internal-only optimisation).
--   5. Data migration: none.
--   6. New role / RLS: none.
--   7. Rollback: `DROP INDEX <name>` per row in DOWN.
--   8. Sign-off: owner.

-- UP

-- Provider portal hot paths -------------------------------------------------
CREATE INDEX IF NOT EXISTS lead_notes_provider_user_id_idx
  ON crm.lead_notes (provider_user_id);

CREATE INDEX IF NOT EXISTS lead_notes_author_user_id_idx
  ON crm.lead_notes (author_user_id);

CREATE INDEX IF NOT EXISTS enrolments_routing_log_id_idx
  ON crm.enrolments (routing_log_id);

CREATE INDEX IF NOT EXISTS sheet_edits_log_submission_id_idx
  ON crm.sheet_edits_log (submission_id);

CREATE INDEX IF NOT EXISTS billing_events_enrolment_id_idx
  ON crm.billing_events (enrolment_id);

CREATE INDEX IF NOT EXISTS billing_events_submission_id_idx
  ON crm.billing_events (submission_id);

CREATE INDEX IF NOT EXISTS support_requests_provider_user_id_idx
  ON crm.support_requests (provider_user_id);

CREATE INDEX IF NOT EXISTS submissions_parent_submission_id_idx
  ON leads.submissions (parent_submission_id);

-- Admin / hygiene -----------------------------------------------------------
CREATE INDEX IF NOT EXISTS enrolments_callback_requested_by_idx
  ON crm.enrolments (callback_requested_by);

CREATE INDEX IF NOT EXISTS providers_sla_accepted_by_user_id_idx
  ON crm.providers (sla_accepted_by_user_id);

CREATE INDEX IF NOT EXISTS provider_users_invited_by_idx
  ON crm.provider_users (invited_by);

CREATE INDEX IF NOT EXISTS provider_users_current_invite_issued_by_idx
  ON crm.provider_users (current_invite_issued_by);

CREATE INDEX IF NOT EXISTS routing_config_updated_by_idx
  ON crm.routing_config (updated_by);

CREATE INDEX IF NOT EXISTS billing_events_created_by_idx
  ON crm.billing_events (created_by);

CREATE INDEX IF NOT EXISTS pending_updates_source_log_id_idx
  ON crm.pending_updates (source_log_id);

CREATE INDEX IF NOT EXISTS support_requests_resolved_by_idx
  ON crm.support_requests (resolved_by);

CREATE INDEX IF NOT EXISTS dead_letter_replay_submission_id_idx
  ON leads.dead_letter (replay_submission_id);

-- Audit ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS access_requests_processed_by_idx
  ON audit.access_requests (processed_by);

CREATE INDEX IF NOT EXISTS erasure_requests_processed_by_idx
  ON audit.erasure_requests (processed_by);

-- DOWN
-- DROP INDEX IF EXISTS crm.lead_notes_provider_user_id_idx;
-- DROP INDEX IF EXISTS crm.lead_notes_author_user_id_idx;
-- DROP INDEX IF EXISTS crm.enrolments_routing_log_id_idx;
-- DROP INDEX IF EXISTS crm.sheet_edits_log_submission_id_idx;
-- DROP INDEX IF EXISTS crm.billing_events_enrolment_id_idx;
-- DROP INDEX IF EXISTS crm.billing_events_submission_id_idx;
-- DROP INDEX IF EXISTS crm.support_requests_provider_user_id_idx;
-- DROP INDEX IF EXISTS leads.submissions_parent_submission_id_idx;
-- DROP INDEX IF EXISTS crm.enrolments_callback_requested_by_idx;
-- DROP INDEX IF EXISTS crm.providers_sla_accepted_by_user_id_idx;
-- DROP INDEX IF EXISTS crm.provider_users_invited_by_idx;
-- DROP INDEX IF EXISTS crm.provider_users_current_invite_issued_by_idx;
-- DROP INDEX IF EXISTS crm.routing_config_updated_by_idx;
-- DROP INDEX IF EXISTS crm.billing_events_created_by_idx;
-- DROP INDEX IF EXISTS crm.pending_updates_source_log_id_idx;
-- DROP INDEX IF EXISTS crm.support_requests_resolved_by_idx;
-- DROP INDEX IF EXISTS leads.dead_letter_replay_submission_id_idx;
-- DROP INDEX IF EXISTS audit.access_requests_processed_by_idx;
-- DROP INDEX IF EXISTS audit.erasure_requests_processed_by_idx;
