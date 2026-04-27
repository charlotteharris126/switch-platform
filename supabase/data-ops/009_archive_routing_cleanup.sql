-- Data-ops 009 — Routing-state cleanup: archived test rows + Lana Ayres duplicate
-- Date: 2026-04-25
-- Author: Claude (platform Session D audit) with owner sign-off
-- Reason: Single source of truth requires DB routed count = provider sheet count.
--         Three cleanups in one file:
--
--   (1) Submission id 29 (charliemarieharris@icloud.com test 6):
--         Currently primary_routed_to='enterprise-made-simple' but is_dq=true,
--         archived_at set. Was routed before owner-test detection ran. Sheet
--         count never included this row. Clear primary_routed_to so dashboard
--         stops counting it as routed.
--
--   (2) Submission id 30 (test7@testing.com tst 7):
--         Same story — archived dummy-test row. Clear primary_routed_to.
--
--   (3) leads.routing_log id=8 (Lana Ayres, submission_id=21):
--         Routed twice on 2026-04-20 — once via manual_sheet (id=7, kept) and
--         again via manual_email (id=8, this row). Same lead, same provider,
--         two delivery methods recorded as separate routing events. Sheet only
--         contains Lana once. Convention: routing_log records once per
--         (submission, provider). Delete id=8.
--
-- Impact: total routed_count drops from 67 (DB) to 65 (matches the three
-- providers' sheets). routing_log row count drops from 68 to 67 events.
-- No active leads affected.
--
-- Related: platform/docs/changelog.md (audit entry to follow),
--          platform/docs/data-architecture.md.

BEGIN;

-- (1) + (2) Clear primary_routed_to on archived test rows
UPDATE leads.submissions
SET primary_routed_to = NULL,
    routed_at = NULL
WHERE id IN (29, 30)
  AND is_dq = true
  AND archived_at IS NOT NULL
  AND email IN ('charliemarieharris@icloud.com', 'test7@testing.com');

-- (3) Delete the Lana Ayres duplicate routing log row
DELETE FROM leads.routing_log
WHERE id = 8
  AND submission_id = 21
  AND provider_id = 'enterprise-made-simple'
  AND delivery_method = 'manual_email';

-- Verify counts before commit
DO $$
DECLARE
  routed_count INT;
  routing_log_count INT;
BEGIN
  SELECT COUNT(*) INTO routed_count FROM leads.submissions WHERE primary_routed_to IS NOT NULL AND archived_at IS NULL;
  SELECT COUNT(*) INTO routing_log_count FROM leads.routing_log;
  RAISE NOTICE 'Post-cleanup routed (active, not archived): %', routed_count;
  RAISE NOTICE 'Post-cleanup routing_log count: %', routing_log_count;
END $$;

COMMIT;
