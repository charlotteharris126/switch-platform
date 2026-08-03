-- Migration 0238 — allow 'employer_intro' in crm.sms_log.comm_type
-- Date: 2026-08-03
-- Author: Claude (Sasha/platform session) with owner sign-off
-- Reason: the B2B initial SMS (fireEmployerInitialSms, employer-lead-core
--   post-route fan-out) logs comm_type 'employer_intro'. The existing
--   sms_log_comm_type_check CHECK only permits the three learner values, so the
--   insert was rejected and the send silently dropped (first hit: Paul Malcolm
--   McGuire, submission 763, 2026-08-03 18:30). This adds the new value to the
--   allow-list. Superset of the prior three — nothing removed.
-- Impact (§8): CHECK constraint widen on crm.sms_log. Only producer is sendSms
--   (_shared/brevo.ts); the new value is already emitted by the deployed
--   employer routers. No consumer filters comm_type to a closed set that would
--   break on the new value. No data migration. Reversible (DOWN restores the
--   three-value CHECK — safe only while no 'employer_intro' rows exist).
-- Related: 0234 (business_status), employer-lead-core.ts, _shared/sms-utility.ts.

-- UP
ALTER TABLE crm.sms_log DROP CONSTRAINT sms_log_comm_type_check;
ALTER TABLE crm.sms_log ADD CONSTRAINT sms_log_comm_type_check
  CHECK (comm_type = ANY (ARRAY[
    'call_reminder_fastrack_link'::text,
    'call_reminder_save_number'::text,
    'chaser_call_attempt'::text,
    'employer_intro'::text
  ]));

-- DOWN
-- ALTER TABLE crm.sms_log DROP CONSTRAINT sms_log_comm_type_check;
-- ALTER TABLE crm.sms_log ADD CONSTRAINT sms_log_comm_type_check
--   CHECK (comm_type = ANY (ARRAY[
--     'call_reminder_fastrack_link'::text,
--     'call_reminder_save_number'::text,
--     'chaser_call_attempt'::text
--   ]));
