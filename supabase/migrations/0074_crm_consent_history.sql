-- Migration 0074 — crm.consent_history: audit log for consent state changes
-- Date: 2026-05-05
-- Author: Claude (session) with owner sign-off
-- Reason: Phase 1 of the email platform rearchitecture. Records every
--   change to a contact's marketing/transactional consent state. Source
--   of truth for "when did Sarah unsubscribe?" / "did this contact ever
--   opt in?" questions. Powers GDPR audit trail required by Article 7(1)
--   ("controller shall be able to demonstrate that the data subject has
--   consented").
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new table crm.consent_history + indexes + RLS + grants.
--   2. Readers affected: none today. Future readers — admin dashboard
--      lead detail (Phase 6), GDPR access export (Phase 1 SOP).
--   3. Writers: brevo-event-webhook (unsubscribe events, Phase 1),
--      _shared/brevo.ts contact upsert (consent state changes, Phase 3),
--      backfill script (Phase 3), admin manual edits (Phase 6+).
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role/policy: same pattern as crm.email_log.
--   7. Rollback: DROP TABLE in DOWN.
--   8. Sign-off: owner (this session).

BEGIN;

CREATE TABLE crm.consent_history (
  id              BIGSERIAL PRIMARY KEY,
  submission_id   BIGINT REFERENCES leads.submissions(id) ON DELETE SET NULL,
  contact_email   TEXT NOT NULL,
  field_changed   TEXT NOT NULL CHECK (field_changed IN (
                    'SW_CONSENT_MARKETING',
                    'SW_CONSENT_TRANSACTIONAL',
                    'email_campaigns_subscription',
                    'transactional_subscription'
                  )),
  old_value       TEXT,
  new_value       TEXT,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by      TEXT NOT NULL CHECK (changed_by IN (
                    'contact',
                    'system',
                    'admin',
                    'backfill'
                  )),
  source          TEXT NOT NULL CHECK (source IN (
                    'form',
                    'unsubscribe_link',
                    'spam_complaint',
                    'admin_dashboard',
                    'api',
                    'reconcile_cron',
                    'backfill'
                  )),
  metadata        JSONB
);

COMMENT ON TABLE crm.consent_history IS
  'Append-only audit log of every consent state change. Both Brevo-attribute changes (SW_CONSENT_MARKETING) and Brevo channel-subscription changes are tracked. submission_id is nullable because contacts can exist without a submission (e.g. blog newsletter signups in future phases). Migration 0074, Phase 1 of email platform rearchitecture.';

COMMENT ON COLUMN crm.consent_history.contact_email IS
  'Email address of the contact at the time of the change. Stored separately from submission_id so consent history survives PII anonymisation of the submissions row (GDPR erasure).';

COMMENT ON COLUMN crm.consent_history.changed_by IS
  'Actor: contact (clicked unsubscribe), system (automated reconciliation), admin (dashboard manual edit), backfill (one-off script).';

COMMENT ON COLUMN crm.consent_history.source IS
  'Surface that triggered the change. form = consent at lead submission. unsubscribe_link = clicked Brevo {{ unsubscribe }}. spam_complaint = flagged as spam. admin_dashboard = manual override. api = explicit API call. reconcile_cron = drift fix from brevo-consent-reconcile-daily. backfill = one-off Phase 3 script.';

-- "Show me consent history for this submission"
CREATE INDEX consent_history_submission_idx
  ON crm.consent_history (submission_id, changed_at DESC)
  WHERE submission_id IS NOT NULL;

-- "Show me consent history for this email address" (post-anonymisation, post-newsletter)
CREATE INDEX consent_history_email_idx
  ON crm.consent_history (contact_email, changed_at DESC);

-- "Show me all unsubscribe events in the last 7 days"
CREATE INDEX consent_history_field_changed_at_idx
  ON crm.consent_history (field_changed, changed_at DESC);

ALTER TABLE crm.consent_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY analytics_read_consent_history ON crm.consent_history
  FOR SELECT TO readonly_analytics USING (true);

CREATE POLICY admin_read_consent_history ON crm.consent_history
  FOR SELECT TO authenticated USING (admin.is_admin());

-- Append-only by design: INSERT only, no UPDATE/DELETE policy. Even
-- functions_writer cannot rewrite history. Erasure flow uses
-- audit.erasure_requests + targeted column anonymisation, never row deletion.
CREATE POLICY functions_writer_insert_consent_history ON crm.consent_history
  FOR INSERT TO functions_writer WITH CHECK (true);

GRANT SELECT ON crm.consent_history TO authenticated, readonly_analytics;
GRANT SELECT, INSERT ON crm.consent_history TO functions_writer;
GRANT USAGE, SELECT ON SEQUENCE crm.consent_history_id_seq TO functions_writer;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS functions_writer_insert_consent_history ON crm.consent_history;
-- DROP POLICY IF EXISTS admin_read_consent_history ON crm.consent_history;
-- DROP POLICY IF EXISTS analytics_read_consent_history ON crm.consent_history;
-- DROP TABLE IF EXISTS crm.consent_history;
-- COMMIT;
