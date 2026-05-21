-- Migration 0156 — crm.sms_log + crm.providers SMS opt-out flags (Chunk 1, SMS utility foundation)
-- Date: 2026-05-21
-- Author: Claude (Sasha, platform session) with owner sign-off
-- Reason:
--   Chunk 1 of the SMS utility build per `switchable/email/docs/sms-utility-design.md`
--   (Wren, locked 2026-05-21 after Brevo sender went LIVE at 16:35 UK). Foundation
--   only: log table + per-provider opt-out flags. No triggers wired in this migration
--   — Chunk 2 wires Triggers B (save-number) + C (chaser) into existing Edge Functions,
--   Chunk 3 ships Trigger A (fastrack-link cron) + short URL infra.
--
--   crm.sms_log mirrors crm.email_log (migration 0073) intentionally — same shape, same
--   role grants, same RLS posture. Idempotency on (submission_id, comm_type) matches the
--   "each comm fires once per learner per type" design from the spec. Three comm types
--   locked: call_reminder_fastrack_link (Trigger A), call_reminder_save_number (Trigger B),
--   chaser_call_attempt (Trigger C).
--
--   Two boolean flags on crm.providers (sms_utility_enabled, sms_chaser_enabled) gate
--   Triggers A+B and Trigger C independently per provider. Default true means live
--   providers opt-in by default; flip to false if any provider asks out.
--
-- Related:
--   switchable/email/docs/sms-utility-design.md (full spec, "What Sasha needs" section)
--   platform/supabase/functions/_shared/brevo.ts (sendSms helper ships in same chunk)
--   platform/supabase/functions/admin-test-sms (test surface ships in same chunk)
--   platform/docs/data-architecture.md (gets crm.sms_log section + provider flag entries)
--   platform/docs/changelog.md (entry at top)
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new table crm.sms_log + indexes + RLS + grants; two new BOOLEAN columns
--      on crm.providers (sms_utility_enabled, sms_chaser_enabled, NOT NULL DEFAULT true).
--      No data migration. No existing column touched.
--   2. Readers: readonly_analytics (Metabase, agent MCPs, future /admin/sms panel) gains
--      a new readable table. No existing query breaks. crm.providers reads gain two new
--      columns — additive, no consumer reads them today.
--   3. Writers: functions_writer via the sendSms helper (this chunk) and a future sms
--      delivery-event webhook (out of scope, Chunk 3+). No other writer.
--   4. Schema_version: internal table, no external contract ingested here. No bump.
--   5. Data migration: none. crm.providers existing rows pick up default true on both
--      new columns — matches the spec's "live providers opt-in by default" intent.
--   6. New role / policy: no new role. New RLS policies scoped to existing roles.
--   7. Rollback: DROP TABLE crm.sms_log, ALTER TABLE crm.providers DROP COLUMN sms_*. Safe
--      before any send writes here.
--   8. Sign-off: owner 2026-05-21.

BEGIN;

-- =====================================================================
-- crm.sms_log
-- =====================================================================

CREATE TABLE crm.sms_log (
  id                BIGSERIAL PRIMARY KEY,
  submission_id     BIGINT NOT NULL REFERENCES leads.submissions(id) ON DELETE RESTRICT,
  comm_type         TEXT NOT NULL CHECK (comm_type IN (
                      'call_reminder_fastrack_link',
                      'call_reminder_save_number',
                      'chaser_call_attempt'
                    )),
  recipient_phone   TEXT NOT NULL,
  triggered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ,
  status            TEXT NOT NULL CHECK (status IN (
                      'queued',
                      'sent',
                      'failed',
                      'delivered',
                      'undelivered'
                    )),
  brevo_message_id  TEXT,
  body_rendered     TEXT,
  error_text        TEXT,
  metadata          JSONB
);

COMMENT ON TABLE crm.sms_log IS
  'One row per SMS send attempt. Utility SMS only (legal basis: contract). Three comm_types per the Wren design (sms-utility-design.md, 2026-05-21): call_reminder_fastrack_link (Trigger A cron), call_reminder_save_number (Trigger B inside fastrack-receive), chaser_call_attempt (Trigger C inside markOutcomeAction). Idempotency on (submission_id, comm_type) — each comm fires once per learner per type, no force-resend pattern. Migration 0156.';

COMMENT ON COLUMN crm.sms_log.comm_type IS
  'Logical SMS variant. Add new values via ALTER TABLE...DROP CONSTRAINT...ADD CONSTRAINT — never repurpose an existing value. Mirrors crm.email_log.email_type discipline. Migration 0156.';

COMMENT ON COLUMN crm.sms_log.recipient_phone IS
  'E.164-formatted recipient phone at send time. Captured here (not just referenced via submission) so analytics can survive a learner GDPR-erasure scrub on leads.submissions. Migration 0156.';

COMMENT ON COLUMN crm.sms_log.body_rendered IS
  'Plain text body actually sent, with all merge fields resolved. Bodies are template-literal in TS not Brevo-templated (see sms-utility-design.md "Channel posture"), so this column is the only post-hoc record of what the learner actually received. Migration 0156.';

COMMENT ON COLUMN crm.sms_log.brevo_message_id IS
  'Brevo Transactional SMS API returns a messageId on send. Populated on status=sent. Used to correlate delivery webhook events back to this row in Chunk 3+. Migration 0156.';

COMMENT ON COLUMN crm.sms_log.metadata IS
  'Free-form JSONB for shadow-mode flag, retry counts, provider_id at send time, etc. Not for PII. Migration 0156.';

-- Idempotency lookup: "has comm_type X already been sent for submission Y?"
CREATE UNIQUE INDEX sms_log_submission_type_uniq
  ON crm.sms_log (submission_id, comm_type)
  WHERE status IN ('queued', 'sent', 'delivered');

COMMENT ON INDEX crm.sms_log_submission_type_uniq IS
  'Idempotency guard at the index level. A failed/undelivered row does NOT block a re-send (the failure mode is the same as crm.email_log — a prior send error should not silently silence the next legitimate attempt). Partial unique on the non-terminal statuses, mirroring the pattern in sendTransactional. Migration 0156.';

-- Status sweeps: "show me failed sends in the last 24h" / "stuck queued rows"
CREATE INDEX sms_log_status_triggered_idx
  ON crm.sms_log (status, triggered_at DESC);

-- Webhook correlation (future): "find the sms_log row for this Brevo message_id"
CREATE INDEX sms_log_brevo_message_id_idx
  ON crm.sms_log (brevo_message_id)
  WHERE brevo_message_id IS NOT NULL;

ALTER TABLE crm.sms_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY analytics_read_sms_log ON crm.sms_log
  FOR SELECT TO readonly_analytics USING (true);

CREATE POLICY admin_read_sms_log ON crm.sms_log
  FOR SELECT TO authenticated USING (admin.is_admin());

CREATE POLICY functions_writer_all_sms_log ON crm.sms_log
  FOR ALL TO functions_writer USING (true) WITH CHECK (true);

GRANT SELECT ON crm.sms_log TO authenticated, readonly_analytics;
GRANT SELECT, INSERT, UPDATE ON crm.sms_log TO functions_writer;
GRANT USAGE, SELECT ON SEQUENCE crm.sms_log_id_seq TO functions_writer;

-- =====================================================================
-- crm.providers SMS opt-out flags
-- =====================================================================

ALTER TABLE crm.providers
  ADD COLUMN sms_utility_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN sms_chaser_enabled  BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN crm.providers.sms_utility_enabled IS
  'Gates Triggers A and B (fastrack-link cron + save-number on qualify-PASS). When false, no utility SMS lands for learners matched to this provider. Default true means live providers opt in by default; flip to false if a provider asks out. Independent of sms_chaser_enabled. Migration 0156.';

COMMENT ON COLUMN crm.providers.sms_chaser_enabled IS
  'Gates Trigger C (chaser SMS on attempt_1_no_answer). When false, no chaser SMS lands for this provider''s attempt-1 misses. Email chaser still fires regardless. Default true. Migration 0156.';

COMMIT;

-- =====================================================================
-- VERIFICATION
-- =====================================================================
--   1. Table exists with correct shape:
--      SELECT column_name, data_type, is_nullable
--        FROM information_schema.columns
--       WHERE table_schema='crm' AND table_name='sms_log'
--       ORDER BY ordinal_position;
--
--   2. Idempotency index is partial on non-terminal statuses:
--      SELECT indexname, indexdef
--        FROM pg_indexes
--       WHERE schemaname='crm' AND tablename='sms_log';
--      Expected: sms_log_submission_type_uniq with WHERE status IN ('queued','sent','delivered').
--
--   3. Provider flags both present and default true:
--      SELECT column_name, column_default
--        FROM information_schema.columns
--       WHERE table_schema='crm' AND table_name='providers'
--         AND column_name IN ('sms_utility_enabled','sms_chaser_enabled');
--
--   4. Existing providers inherit defaults:
--      SELECT provider_id, sms_utility_enabled, sms_chaser_enabled
--        FROM crm.providers
--       WHERE archived_at IS NULL;
--      Expected: every row has true on both columns.
--
--   5. RLS + grants line up with crm.email_log:
--      SELECT policyname, roles FROM pg_policies
--       WHERE schemaname='crm' AND tablename='sms_log';
--      Expected: analytics_read_sms_log, admin_read_sms_log, functions_writer_all_sms_log.

-- =====================================================================
-- DOWN
-- =====================================================================
-- BEGIN;
-- ALTER TABLE crm.providers DROP COLUMN IF EXISTS sms_chaser_enabled;
-- ALTER TABLE crm.providers DROP COLUMN IF EXISTS sms_utility_enabled;
-- DROP POLICY IF EXISTS functions_writer_all_sms_log ON crm.sms_log;
-- DROP POLICY IF EXISTS admin_read_sms_log ON crm.sms_log;
-- DROP POLICY IF EXISTS analytics_read_sms_log ON crm.sms_log;
-- DROP TABLE IF EXISTS crm.sms_log;
-- COMMIT;
