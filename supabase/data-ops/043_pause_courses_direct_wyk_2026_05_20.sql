-- Data-ops 043 — Pause Courses Direct + WYK Digital (block routing, keep visible)
-- Date:   2026-05-20
-- Author: Sasha (Charlotte's session)
-- Reason:
--   Both providers have pilot_status='paused' already, but pilot_status is
--   metadata only — routing in _shared/route-lead.ts gates on provider.active
--   and archived_at, not pilot_status. So they could still receive leads
--   despite the "paused" label. Flip active=false to actually block routing.
--   Not archiving: paused is temporary, archived is permanent. The admin
--   providers list does not filter on active, so they stay visible (with
--   the existing "Inactive" badge styling). Re-enable by setting
--   active=true when they un-pause.
--
-- Impact: 2 UPDATEs. routeLead returns 'provider_inactive' for any future
-- lead matching their region/criteria; the lead lands in submissions and
-- waits for owner re-route or a different match. No data loss.

BEGIN;

UPDATE crm.providers
   SET active     = false,
       updated_at = now()
 WHERE provider_id IN ('courses-direct', 'wyk-digital')
   AND active     = true;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- UPDATE crm.providers
--    SET active = true, updated_at = now()
--  WHERE provider_id IN ('courses-direct', 'wyk-digital');
-- COMMIT;
