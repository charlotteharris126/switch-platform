-- Migration 0047 — sheet→DB mirror audit log + AI pending-updates queue
-- Date: 2026-04-30
-- Author: Claude (platform session) with owner sign-off
-- Reason: Owner is losing track of lead pipeline state across three pilot
-- providers (EMS, WYK Digital, Courses Direct) because providers update
-- sheets in two different ways: sometimes the Status column, sometimes a
-- free-text Notes column. crm.enrolments exists but never advances —
-- nothing flows back from the sheets. This migration adds the schema layer
-- for a hybrid sheet→DB mirror: deterministic for Status edits,
-- AI-suggest-then-owner-approve for Notes edits.
--
-- Adds:
--   1. crm.sheet_edits_log — audit row per sheet edit captured by the
--      provider-sheet-edit-mirror Apps Script trigger. Captures both
--      Channel A (Status, deterministic mirror) and Channel B (Notes,
--      AI-interpreted) events. Decoupled from crm.enrolments enum so
--      future enum changes only touch the Edge Function mapping.
--   2. crm.pending_updates — queue of AI-suggested status changes
--      awaiting owner approval. One row per AI suggestion. Resolved via
--      HMAC-signed Approve / Reject / Override links in email (same
--      pattern as routing-confirm). Source-tagged so future suggestion
--      sources (e.g. learner self-report) can share the queue.
--
-- Phase 4 retirement:
--   When the provider dashboard ships, the Apps Script onEdit trigger and
--   sheet-edit-mirror Edge Function retire. crm.sheet_edits_log is kept
--   as historical audit. crm.pending_updates carries forward — the
--   suggestion-and-approve pattern applies to other future signal sources
--   regardless of sheets.
--
-- Related:
--   - platform/docs/sheet-mirror-scoping.md (design)
--   - platform/supabase/functions/sheet-edit-mirror (target Edge Function)
--   - platform/supabase/functions/pending-update-confirm (approval handler)
--   - platform/apps-scripts/provider-sheet-edit-mirror.gs (onEdit trigger)
--   - .claude/rules/data-infrastructure.md (governance)
--   - .claude/rules/schema-versioning.md (additive change, no payload bump)

-- UP

CREATE TABLE crm.sheet_edits_log (
  id                BIGSERIAL PRIMARY KEY,

  -- Resolved enrolment context (nullable: edit may reference a lead with
  -- no enrolment row, e.g. pre-0042 routed leads pending backfill).
  enrolment_id      BIGINT REFERENCES crm.enrolments(id),
  submission_id     BIGINT REFERENCES leads.submissions(id),
  provider_id       TEXT NOT NULL REFERENCES crm.providers(provider_id),

  -- The sheet edit itself.
  column_name       TEXT NOT NULL,            -- 'Status' | 'Updates' (extensible)
  old_value         TEXT,
  new_value         TEXT,
  editor_email      TEXT,                     -- Google account that made the edit, if available
  edited_at         TIMESTAMPTZ NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- What the system did with the edit.
  action            TEXT NOT NULL,
  -- Allowed actions:
  --   'mirrored'      - Channel A: Status edit auto-applied to crm.enrolments
  --   'queued'        - Channel A anomaly: status edit could not auto-apply (regression, post-billing override, unmapped)
  --   'note_only'     - Channel B: AI read the note, no status implication, logged
  --   'ai_suggested'  - Channel B: AI suggested a status change, queued for owner approval
  --   'ai_approved'   - Channel B: owner approved the suggestion, applied
  --   'ai_rejected'   - Channel B: owner rejected the suggestion, no change
  --   'ai_overridden' - Channel B: owner overrode with a different status, applied
  --   'ai_error'      - Channel B: Claude API error or malformed output
  --   'rejected'      - Channel A: edit malformed at the function layer (e.g. lead_id not found)

  applied_status    TEXT,                     -- crm.enrolments.status value applied, if any

  -- Channel B-only fields. Null for Channel A rows.
  ai_summary        TEXT,                     -- Plain-English summary from Claude
  ai_implied_status TEXT,                     -- What Claude suggested
  ai_confidence     TEXT,                     -- 'high' | 'medium' | 'low'
  prompt_version    TEXT,                     -- Versioned prompt tag, e.g. 'v1'
  pending_update_id BIGINT,                   -- FK assigned after pending_updates row created (see below)

  reason            TEXT,                     -- Why queued / rejected / errored, free text
  notes             TEXT
);

COMMENT ON TABLE crm.sheet_edits_log IS
  'Audit row per provider sheet edit captured by the onEdit Apps Script trigger. Covers Channel A (Status, deterministic) and Channel B (Notes, AI-interpreted). Decoupled from crm.enrolments enum so future status enum changes only affect the Edge Function mapping. Retires with Phase 4 dashboard but is retained as historical audit.';

COMMENT ON COLUMN crm.sheet_edits_log.action IS
  'mirrored | queued | note_only | ai_suggested | ai_approved | ai_rejected | ai_overridden | ai_error | rejected. See migration 0047 header for full definitions.';

CREATE INDEX ON crm.sheet_edits_log (provider_id, received_at DESC);
CREATE INDEX ON crm.sheet_edits_log (enrolment_id);
CREATE INDEX ON crm.sheet_edits_log (action, received_at DESC)
  WHERE action NOT IN ('mirrored', 'note_only', 'ai_approved');

-- RLS: enable with explicit SELECT policies matching the pattern of other
-- crm tables (admin dashboard reads via authenticated role; readonly_analytics
-- for Mira/Iris MCP). Edge Functions reach it via the service role which
-- bypasses RLS — no INSERT/UPDATE policies needed.
-- IMPORTANT: RLS policies are useless without a base GRANT — Postgres checks
-- table-level privileges before applying RLS. Grants must be explicit per
-- role even though policies reference them.
GRANT SELECT ON crm.sheet_edits_log TO authenticated;
ALTER TABLE crm.sheet_edits_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_read_sheet_edits_log ON crm.sheet_edits_log
  FOR SELECT TO authenticated USING (true);
CREATE POLICY analytics_read_sheet_edits_log ON crm.sheet_edits_log
  FOR SELECT TO readonly_analytics USING (true);


CREATE TABLE crm.pending_updates (
  id                        BIGSERIAL PRIMARY KEY,

  enrolment_id              BIGINT NOT NULL REFERENCES crm.enrolments(id),

  -- Where this suggestion came from. Extensible: today only 'sheet_note_ai',
  -- future: 'learner_self_report_ai', 'call_transcript_ai', etc.
  source                    TEXT NOT NULL,
  source_log_id             BIGINT REFERENCES crm.sheet_edits_log(id),
  source_payload            JSONB,                       -- Raw note + lead context sent to Claude (PII-redacted)

  -- The suggestion itself.
  current_status            TEXT NOT NULL,               -- Status snapshot at time of suggestion (audit)
  suggested_status          TEXT NOT NULL,               -- AI's pick
  ai_summary                TEXT,
  ai_rationale              TEXT,
  ai_confidence             TEXT,
  prompt_version            TEXT,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Resolution.
  status                    TEXT NOT NULL DEFAULT 'pending',
  -- Allowed: 'pending' | 'approved' | 'rejected' | 'overridden' | 'expired'
  override_status           TEXT,                        -- crm.enrolments.status value chosen if overridden
  resolved_at               TIMESTAMPTZ,
  resolved_by               TEXT,                        -- 'owner' | 'auto_expire'
  applied_at                TIMESTAMPTZ,                 -- When the resulting status update hit crm.enrolments

  -- Expiry timestamp for the HMAC-signed Approve/Reject/Override email
  -- buttons. Tokens themselves are stateless (signed with PENDING_UPDATE_SECRET,
  -- payload binds pending_update_id + action + expires_at) so the DB does not
  -- need to store them. This column drives the daily auto-expire cron sweep.
  resolver_token_expires_at TIMESTAMPTZ NOT NULL          -- 7 days from created_at
);

COMMENT ON TABLE crm.pending_updates IS
  'Queue of AI-suggested enrolment status changes awaiting owner approval. Resolved via stateless HMAC-signed email links (Approve/Reject/Override). Source-tagged for future expansion beyond sheet notes.';

COMMENT ON COLUMN crm.pending_updates.status IS
  'pending | approved | rejected | overridden | expired. See migration 0047 header for full definitions.';

CREATE INDEX ON crm.pending_updates (status, created_at DESC) WHERE status = 'pending';
CREATE INDEX ON crm.pending_updates (enrolment_id);
CREATE INDEX ON crm.pending_updates (resolver_token_expires_at) WHERE status = 'pending';

-- Realtime: dashboard subscribes to changes on both tables for auto-refresh.
ALTER PUBLICATION supabase_realtime ADD TABLE crm.sheet_edits_log;
ALTER PUBLICATION supabase_realtime ADD TABLE crm.pending_updates;

-- RLS: same posture as crm.sheet_edits_log.
GRANT SELECT ON crm.pending_updates TO authenticated;
ALTER TABLE crm.pending_updates ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_read_pending_updates ON crm.pending_updates
  FOR SELECT TO authenticated USING (true);
CREATE POLICY analytics_read_pending_updates ON crm.pending_updates
  FOR SELECT TO readonly_analytics USING (true);


-- DOWN
-- DROP INDEX crm.pending_updates_resolver_token_expires_at_idx;
-- DROP INDEX crm.pending_updates_enrolment_id_idx;
-- DROP INDEX crm.pending_updates_status_created_at_idx;
-- DROP TABLE crm.pending_updates;
-- DROP INDEX crm.sheet_edits_log_action_received_at_idx;
-- DROP INDEX crm.sheet_edits_log_enrolment_id_idx;
-- DROP INDEX crm.sheet_edits_log_provider_id_received_at_idx;
-- DROP TABLE crm.sheet_edits_log;
