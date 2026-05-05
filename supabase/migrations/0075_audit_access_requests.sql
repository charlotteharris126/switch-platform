-- Migration 0075 — audit.access_requests: GDPR Article 15 right-of-access log
-- Date: 2026-05-05
-- Author: Claude (session) with owner sign-off
-- Reason: Phase 1 of the email platform rearchitecture. Mirrors
--   audit.erasure_requests (which has been live since migration 0016)
--   for the right-of-access counterpart. The original spec proposed a
--   separate crm.erasure_log + crm.access_log; on review,
--   audit.erasure_requests already covers erasure with a richer schema
--   (per-system result JSONBs, identity-verification step, status
--   machine), so this migration adds only the missing access_requests
--   table using the same shape.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new table audit.access_requests + indexes + RLS + grants.
--   2. Readers affected: none today. Future readers — admin GDPR page,
--      Charlotte's monthly compliance audit.
--   3. Writers: GDPR access-export script (Phase 1 SOP), admin manual
--      entries via dashboard (Phase 6+).
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role/policy: matches audit.erasure_requests pattern from 0016.
--   7. Rollback: DROP TABLE in DOWN.
--   8. Sign-off: owner (this session).

BEGIN;

CREATE TABLE audit.access_requests (
  id                   BIGSERIAL PRIMARY KEY,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  requester_email      TEXT NOT NULL,
  identity_verified_at TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                        'pending', 'verifying', 'in_progress', 'completed', 'rejected'
                      )),
  rejection_reason     TEXT,
  -- Per-system export results (one JSONB per system, mirroring erasure_requests)
  supabase_result      JSONB,
  brevo_result         JSONB,
  netlify_result       JSONB,
  meta_capi_result     JSONB,
  google_ads_result    JSONB,
  -- Where the JSON export landed once completed (signed Supabase Storage URL,
  -- short-lived). NULL until status='completed'.
  export_url           TEXT,
  completed_at         TIMESTAMPTZ,
  processed_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  notes                TEXT
);

COMMENT ON TABLE audit.access_requests IS
  'GDPR Article 15 right-of-access log. Sibling to audit.erasure_requests. One row per access request from receipt through to completion. Per-system JSONB columns capture what was pulled from each consumer system (Supabase, Brevo, Meta CAPI, etc.). export_url is the signed Storage URL where the requester''s JSON export lives. Migration 0075, Phase 1 of email platform rearchitecture.';

CREATE INDEX access_requests_status_idx      ON audit.access_requests (status);
CREATE INDEX access_requests_received_at_idx ON audit.access_requests (received_at DESC);
CREATE INDEX access_requests_email_idx       ON audit.access_requests (requester_email);

ALTER TABLE audit.access_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_read_access_requests ON audit.access_requests
  FOR SELECT TO authenticated USING (admin.is_admin());

CREATE POLICY analytics_read_access_requests ON audit.access_requests
  FOR SELECT TO readonly_analytics USING (true);

CREATE POLICY functions_writer_all_access_requests ON audit.access_requests
  FOR ALL TO functions_writer USING (true) WITH CHECK (true);

GRANT SELECT ON audit.access_requests TO authenticated;
GRANT SELECT ON audit.access_requests TO readonly_analytics;
GRANT SELECT, INSERT, UPDATE ON audit.access_requests TO functions_writer;
GRANT USAGE, SELECT ON SEQUENCE audit.access_requests_id_seq TO functions_writer;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS functions_writer_all_access_requests ON audit.access_requests;
-- DROP POLICY IF EXISTS analytics_read_access_requests ON audit.access_requests;
-- DROP POLICY IF EXISTS admin_read_access_requests ON audit.access_requests;
-- DROP TABLE IF EXISTS audit.access_requests;
-- COMMIT;
