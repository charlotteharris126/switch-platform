-- Migration 0073 — crm.email_log: per-send audit table for the email platform rearchitecture
-- Date: 2026-05-05
-- Author: Claude (session) with owner sign-off
-- Reason: Phase 1 of the email platform rearchitecture (spec at
--   platform/docs/email-platform-rearchitecture-spec.md, owner-signed
--   2026-05-05). One row per send attempt across both transactional
--   utility (U1, stalled, chaser, U4) and marketing (N1-N3, referrals,
--   newsletter) emails. Provides the audit log, idempotency key, and
--   bounce/complaint sink that the current automation-only flow lacks.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new table crm.email_log + indexes + RLS + grants. No data
--      migration. No existing column touched.
--   2. Readers affected: none today. Future readers — admin dashboard
--      lead detail page (Phase 6), email-stalled-cron and email-u4-cron
--      idempotency queries (Phase 2), brevo-event-webhook (Phase 1).
--   3. Writers: functions_writer via the sendTransactional helper
--      (Phase 2) and brevo-event-webhook (Phase 1).
--   4. Schema version: not affected. Internal table, no external
--      contract ingested here.
--   5. Data migration: none.
--   6. Role/policy: GRANT SELECT/INSERT/UPDATE to functions_writer
--      (writes during send + status-update on webhook events). SELECT
--      to readonly_analytics. Admin SELECT policy on authenticated.
--   7. Rollback: DROP TABLE in DOWN. Safe before any send writes here.
--   8. Sign-off: owner (this session).
--
-- Related:
--   platform/docs/email-platform-rearchitecture-spec.md (Phase 1)
--   platform/docs/data-architecture.md (gets crm.email_log section)
--   platform/docs/changelog.md (entry at top)

BEGIN;

CREATE TABLE crm.email_log (
  id                BIGSERIAL PRIMARY KEY,
  submission_id     BIGINT NOT NULL REFERENCES leads.submissions(id) ON DELETE RESTRICT,
  email_type        TEXT NOT NULL CHECK (email_type IN (
                      'u1_funded',
                      'u1_self',
                      'stalled_funded',
                      'stalled_self',
                      'chaser',
                      'u4_funded',
                      'u4_self',
                      'n1',
                      'n2',
                      'n3',
                      'referral_cold',
                      'referral_lost',
                      'newsletter'
                    )),
  channel           TEXT NOT NULL CHECK (channel IN ('transactional', 'email_campaigns')),
  template_id       TEXT NOT NULL,
  recipient_email   TEXT NOT NULL,
  triggered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ,
  status            TEXT NOT NULL CHECK (status IN (
                      'queued',
                      'sent',
                      'failed',
                      'bounced_hard',
                      'bounced_soft',
                      'complained',
                      'delivered',
                      'opened',
                      'clicked'
                    )),
  brevo_message_id  TEXT,
  error_text        TEXT,
  metadata          JSONB
);

COMMENT ON TABLE crm.email_log IS
  'One row per email send attempt. Covers both transactional (utility) and email_campaigns (marketing) channels. Used for: idempotency on one-shot emails, audit trail, bounce/complaint state via brevo-event-webhook updates, admin dashboard visibility (Phase 6). Migration 0073, Phase 1 of email platform rearchitecture.';

COMMENT ON COLUMN crm.email_log.email_type IS
  'Logical email name. Add new values via ALTER TABLE...DROP CONSTRAINT...ADD CONSTRAINT — never repurpose an existing value. Migration 0073.';

COMMENT ON COLUMN crm.email_log.channel IS
  'Brevo delivery channel. transactional = utility (always-on, contract basis). email_campaigns = marketing (consent-required, unsubscribable). Migration 0073.';

COMMENT ON COLUMN crm.email_log.brevo_message_id IS
  'Brevo''s message-ID returned from the Transactional API on send. Populated on status=sent. Used to correlate webhook events back to this row. Migration 0073.';

COMMENT ON COLUMN crm.email_log.metadata IS
  'Free-form JSONB for shadow-mode flag, retry counts, A/B variant, etc. Not for PII. Migration 0073.';

-- Idempotency lookup: "has email_type X already been sent for submission Y?"
CREATE INDEX email_log_submission_type_idx
  ON crm.email_log (submission_id, email_type);

-- Status sweeps: "show me failed sends in the last 24h" / "stuck queued rows"
CREATE INDEX email_log_status_triggered_idx
  ON crm.email_log (status, triggered_at DESC);

-- Webhook correlation: "find the email_log row for this Brevo message_id"
CREATE INDEX email_log_brevo_message_id_idx
  ON crm.email_log (brevo_message_id)
  WHERE brevo_message_id IS NOT NULL;

ALTER TABLE crm.email_log ENABLE ROW LEVEL SECURITY;

-- Read for analytics + admin
CREATE POLICY analytics_read_email_log ON crm.email_log
  FOR SELECT TO readonly_analytics USING (true);

CREATE POLICY admin_read_email_log ON crm.email_log
  FOR SELECT TO authenticated USING (admin.is_admin());

-- Write for the Edge Functions (sendTransactional + brevo-event-webhook)
CREATE POLICY functions_writer_all_email_log ON crm.email_log
  FOR ALL TO functions_writer USING (true) WITH CHECK (true);

GRANT SELECT ON crm.email_log TO authenticated, readonly_analytics;
GRANT SELECT, INSERT, UPDATE ON crm.email_log TO functions_writer;
GRANT USAGE, SELECT ON SEQUENCE crm.email_log_id_seq TO functions_writer;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS functions_writer_all_email_log ON crm.email_log;
-- DROP POLICY IF EXISTS admin_read_email_log ON crm.email_log;
-- DROP POLICY IF EXISTS analytics_read_email_log ON crm.email_log;
-- DROP TABLE IF EXISTS crm.email_log;
-- COMMIT;
