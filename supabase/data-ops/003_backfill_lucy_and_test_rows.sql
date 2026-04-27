-- data-ops 003 — backfill Lucy Hizmo routing + DQ two owner tests that slipped the filter
-- Date: 2026-04-21
-- Author: Claude (Switchable ads session) with owner authorisation
-- Reason:
--   (1) Submission id 25 (Lucy Hizmo, 2026-04-20 08:26 UTC) was routed to Enterprise Made Simple
--       manually by the owner (email, per owner recollection). Row landed in EMS's sheet but
--       neither leads.routing_log nor leads.submissions.primary_routed_to were updated. The
--       DB diverged from reality. This backfills both so the 14-day presumed-enrolment clock
--       for Lucy has a correct start point.
--   (2) Submissions id 28 and id 37 are owner GTM/form test submissions that predated the
--       OWNER_TEST_EMAILS filter deployed this session (see 2026-04-21 changelog entry).
--       They incorrectly landed with is_dq=false. Apply the override logic retroactively so
--       they drop out of active-lead views.
--
-- Related:
--   - platform/docs/changelog.md entry 2026-04-21 (late morning) — OWNER_TEST_EMAILS filter
--   - platform/supabase/functions/netlify-lead-router/index.ts — applyOwnerTestOverrides()
--   - platform/supabase/functions/routing-confirm/index.ts — canonical routing writes
--
-- Open investigation: why Lucy's row was routed outside the automated confirm flow remains
-- open. Logs for routing-confirm on 2026-04-20 08:26–09:00 UTC need dashboard access to
-- pull. Surface to Sasha next Monday if not resolved earlier.
--
-- Pattern: data fix per .claude/rules/data-infrastructure.md §2. Not reusable (row-specific).
-- Idempotent via WHERE clauses (no-op if already applied).
--
-- Assumption: routed_at for Lucy set to submitted_at + 5 minutes as a reasonable proxy for
-- the owner-confirm delay. Adjust manually if more precision is needed.

BEGIN;

-- (1) Lucy Hizmo — id 25 — backfill routing to EMS
WITH lucy AS (
  UPDATE leads.submissions
     SET primary_routed_to = 'enterprise-made-simple',
         routed_at         = submitted_at + interval '5 minutes',
         updated_at        = now()
   WHERE id = 25
     AND primary_routed_to IS NULL
  RETURNING id, submitted_at + interval '5 minutes' AS routed_at
)
INSERT INTO leads.routing_log
  (submission_id, provider_id, routed_at, route_reason, delivery_method, delivery_status)
SELECT id, 'enterprise-made-simple', routed_at, 'primary', 'manual_email', 'sent'
FROM lucy
WHERE NOT EXISTS (
  SELECT 1 FROM leads.routing_log
   WHERE submission_id = 25
     AND provider_id   = 'enterprise-made-simple'
);

-- (2) id 28 — owner test "TEST 5" — retroactive DQ
UPDATE leads.submissions
   SET is_dq        = true,
       dq_reason    = 'owner_test_submission',
       provider_ids = '{}',
       archived_at  = now(),
       updated_at   = now()
 WHERE id = 28
   AND is_dq = false;

-- (3) id 37 — owner GTM test — retroactive DQ (predates OWNER_TEST_EMAILS deploy this session)
UPDATE leads.submissions
   SET is_dq        = true,
       dq_reason    = 'owner_test_submission',
       provider_ids = '{}',
       archived_at  = now(),
       updated_at   = now()
 WHERE id = 37
   AND is_dq = false;

-- Verify before commit
SELECT id, is_dq, dq_reason, primary_routed_to, routed_at, archived_at
  FROM leads.submissions
 WHERE id IN (25, 28, 37)
 ORDER BY id;

SELECT submission_id, provider_id, route_reason, delivery_method, delivery_status, routed_at
  FROM leads.routing_log
 WHERE submission_id = 25;

COMMIT;
