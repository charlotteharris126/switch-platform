-- data-ops 010 - Forward correction: re-flag Anita Bucpapaj (submission 184) as DQ
-- Date: 2026-04-27 (Session 14, post DQ-leak fix)
-- Author: Claude (Session 14) with owner approval
-- Reason:
--   Anita Bucpapaj submitted /find-your-course/ at 2026-04-27 18:41 UTC (id 184).
--   She picked qualification = 'professional-body' which is a DQ trigger per
--   switchable/site/deploy/deploy/js/routing.js line 230. The form correctly
--   showed her the DQ holding panel. She then clicked "let me keep on the list"
--   and submitted her contact details. Pre-fix, the form payload carried no
--   DQ marker, so netlify-lead-router treated her as a qualified self-funded
--   lead and routed her to courses-direct.
--
--   The bug was fixed in this same session (ticket 869d2rxap):
--     - switchable/site: form now sends dq_reason hidden input on the
--       holding-panel path (commit ac03d71 on switchable-site).
--     - platform: _shared/ingest.ts now forces provider_ids=[] on any
--       client-flagged DQ row (commit eb69a06 on switch-platform).
--
--   This file corrects the historical row to match what the fixed form would
--   produce: is_dq=true, dq_reason='qual', primary_routed_to=NULL,
--   routed_at=NULL, provider_ids=[].
--
--   The leads.routing_log entry (id 97) is intentionally left in place. It
--   records the historical fact that we did route her at the time. Deleting it
--   would erase audit history; keeping it makes "we routed her then corrected"
--   visible. The Errors page reconciliation card carries a 1-row drift between
--   routing-log and unique-people-routed counts as the trace of this correction.
--
-- Related:
--   - ClickUp ticket: 869d2rxap (high, switchable-site + platform)
--   - platform/docs/changelog.md 2026-04-27 (DQ leak fix)
--   - switchable/site/docs/CHANGELOG.md 2026-04-27 (form fix)
--   - switchable-site commit ac03d71
--   - switch-platform commit eb69a06
--
-- Idempotency: guarded by WHERE id = 184 AND primary_routed_to IS NOT NULL.
--   If already corrected, the UPDATE matches zero rows and is a no-op.
--
-- Pre-flight: Anita's row should still show primary_routed_to='courses-direct'
--   and is_dq=false. After: primary_routed_to=NULL, is_dq=true, dq_reason='qual'.

BEGIN;

-- Pre-flight verification.
SELECT id, email, first_name, last_name, is_dq, dq_reason, primary_routed_to,
       routed_at, provider_ids
  FROM leads.submissions
 WHERE id = 184;

-- Apply correction.
UPDATE leads.submissions
   SET is_dq             = true,
       dq_reason          = 'qual',
       primary_routed_to  = NULL,
       routed_at          = NULL,
       provider_ids       = '{}'::text[],
       updated_at         = now()
 WHERE id = 184
   AND primary_routed_to IS NOT NULL;

-- Verify.
SELECT id, email, first_name, last_name, is_dq, dq_reason, primary_routed_to,
       routed_at, provider_ids
  FROM leads.submissions
 WHERE id = 184;

-- Expected post-state:
--   is_dq = true
--   dq_reason = 'qual'
--   primary_routed_to = NULL
--   routed_at = NULL
--   provider_ids = {}

-- Audit-trail trace: leads.routing_log row 97 stays untouched. It still shows
-- submission 184 was routed to courses-direct at 2026-04-27 18:41:16 UTC. That
-- is what historically happened. The errors-page reconciliation card now shows
-- a 1-row gap (routing_log_rows minus unique_people_routed exceeds the sum of
-- archived + linked-reapps + rapid-fire-dupes by 1) which is the deliberate
-- trace of this corrected misroute.

COMMIT;

-- After COMMIT, owner emails Marty (Courses Direct) so he doesn't waste effort
-- on a now-DQ'd lead. The lead is no longer in his sheet from this side; the
-- DB now treats her as DQ.
