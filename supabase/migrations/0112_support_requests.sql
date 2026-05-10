-- Migration 0112 — crm.support_requests for the provider portal Support form
-- Date:    2026-05-10
-- Author:  Claude (platform Session 39) on Charlotte's instruction
-- Reason:  Replaces the inline "email support@switchleads.co.uk" prompts on
--          the provider portal with a proper Support form + audit trail.
--          One row per submission; on save, an Edge Function fires an email
--          to support@switchleads.co.uk with all the details. Each row
--          tracks email_sent_at so a failed dispatch is recoverable.
--
--          Audit shape: provider_id + provider_user_id + snapshot fields
--          (submitter_email, submitter_name) at write time, so renaming a
--          provider_user later doesn't lose context. resolved_at +
--          resolved_by give us a future close-the-ticket workflow without
--          a schema change.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new table + 5 RLS policies + 2 indexes + GRANTs.
--   2. Readers: future admin "Support inbox" page (not in this session);
--      provider's own past requests (read-only) when we surface them.
--   3. Writers: provider Server Action submitSupportRequestAction (this
--      session). Edge Function provider-support-notify updates
--      email_sent_at via service_role.
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role/policy: provider INSERT scoped to caller's provider; provider
--      SELECT scoped to caller's provider. Mirror of crm.lead_notes.
--   7. Rollback: DROP TABLE.
--   8. Sign-off: owner (this session, 2026-05-10).
-- Related: 0109 (lead_notes pattern), 0096 (provider RLS helper).

BEGIN;

CREATE TABLE crm.support_requests (
  id                BIGSERIAL PRIMARY KEY,
  provider_id       TEXT NOT NULL REFERENCES crm.providers(provider_id),
  provider_user_id  BIGINT NOT NULL REFERENCES crm.provider_users(id),
  submitter_email   TEXT NOT NULL,
  submitter_name    TEXT,
  category          TEXT NOT NULL CHECK (category IN (
    'lead_query', 'billing', 'technical', 'account', 'other'
  )),
  subject           TEXT NOT NULL CHECK (length(trim(subject)) > 0 AND length(subject) <= 200),
  message           TEXT NOT NULL CHECK (length(trim(message)) > 0 AND length(message) <= 5000),
  resolved_at       TIMESTAMPTZ,
  resolved_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_notes  TEXT,
  email_sent_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX support_requests_provider_idx
  ON crm.support_requests (provider_id, created_at DESC);
CREATE INDEX support_requests_unresolved_idx
  ON crm.support_requests (created_at DESC)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE crm.support_requests IS
  'Provider portal Support-form submissions. One row per submission. email_sent_at tracks the dispatch to support@switchleads.co.uk so a failed dispatch is recoverable.';

ALTER TABLE crm.support_requests ENABLE ROW LEVEL SECURITY;

-- Admin: full ALL.
CREATE POLICY admin_all_support_requests
  ON crm.support_requests
  FOR ALL TO authenticated
  USING (admin.is_admin())
  WITH CHECK (admin.is_admin());

-- Analytics readonly.
CREATE POLICY analytics_read_support_requests
  ON crm.support_requests
  FOR SELECT TO readonly_analytics
  USING (true);

-- Service role / functions.
CREATE POLICY functions_all_support_requests
  ON crm.support_requests
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- Provider INSERT: must set provider_id to caller's own provider.
CREATE POLICY provider_insert_support_requests
  ON crm.support_requests
  FOR INSERT TO authenticated
  WITH CHECK (provider_id = crm.provider_user_provider_id());

-- Provider SELECT: own provider's submissions only.
CREATE POLICY provider_read_own_support_requests
  ON crm.support_requests
  FOR SELECT TO authenticated
  USING (provider_id = crm.provider_user_provider_id());

GRANT SELECT, INSERT ON crm.support_requests TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE crm.support_requests_id_seq TO authenticated;

COMMIT;

-- DOWN
-- BEGIN;
-- REVOKE USAGE, SELECT ON SEQUENCE crm.support_requests_id_seq FROM authenticated;
-- REVOKE SELECT, INSERT ON crm.support_requests FROM authenticated;
-- DROP TABLE crm.support_requests;
-- COMMIT;
