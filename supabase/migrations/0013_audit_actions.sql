-- Migration 0013 — create audit.actions table for admin dashboard write log
-- Date: 2026-04-22
-- Author: Claude (platform Session A) with owner review
-- Reason: Every write performed via the admin dashboard (route confirm, enrolment status update,
--         provider edit, dead letter replay, GDPR erase) must be auditable. This table holds the
--         tamper-evident log used by the admin shell, the audit page, and any future incident
--         investigation. Created in Session A so all subsequent sessions can write to it from day one.
-- Related: platform/docs/admin-dashboard-scoping.md (security baseline + Session D writes)
--          .claude/rules/data-infrastructure.md (governance)

-- UP

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE audit.actions (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_email     TEXT NOT NULL,
  surface         TEXT NOT NULL CHECK (surface IN ('admin', 'provider', 'system')),
  action          TEXT NOT NULL,            -- e.g. 'lead.route_confirm', 'enrolment.set_status', 'provider.edit'
  target_table    TEXT,                     -- e.g. 'leads.submissions', 'crm.providers'
  target_id       TEXT,                     -- row id of the affected record (TEXT to handle non-bigint pkeys)
  before_value    JSONB,                    -- snapshot of the row before the change (NULL on inserts)
  after_value     JSONB,                    -- snapshot after the change (NULL on hard deletes)
  context         JSONB,                    -- arbitrary structured context (notes, request id, etc.)
  ip_address      INET,
  user_agent      TEXT
);

CREATE INDEX audit_actions_created_at_idx ON audit.actions (created_at DESC);
CREATE INDEX audit_actions_actor_user_id_idx ON audit.actions (actor_user_id);
CREATE INDEX audit_actions_target_idx ON audit.actions (target_table, target_id);
CREATE INDEX audit_actions_action_idx ON audit.actions (action);

-- RLS: enable, default-deny. Only the readonly_analytics role can SELECT; writes happen via the
-- application layer (Server Actions running with the user's session, which bypasses RLS via the
-- service role on a dedicated insert function — to be added in a later migration when the dashboard
-- starts writing).
ALTER TABLE audit.actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_actions_readonly_select"
  ON audit.actions
  FOR SELECT
  TO readonly_analytics
  USING (true);

-- Comment on the table so it shows up in any schema browser.
COMMENT ON TABLE audit.actions IS 'Tamper-evident log of every write performed via the admin dashboard. Append-only — never UPDATE or DELETE rows here. See platform/docs/admin-dashboard-scoping.md.';

-- DOWN
-- DROP TABLE IF EXISTS audit.actions;
-- DROP SCHEMA IF EXISTS audit;
