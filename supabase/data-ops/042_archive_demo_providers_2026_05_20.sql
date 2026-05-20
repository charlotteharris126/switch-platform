-- Data-ops 042 — Archive the three demo providers + suspend their users
-- Date:   2026-05-20
-- Author: Sasha (Charlotte's session)
-- Reason:
--   The three demo providers (demo-b2c, demo-b2b, demo-provider-ltd) seeded
--   for portal QA during the MVP build (data-ops 019/023/035/036) are no
--   longer needed for Charlotte's live admin work. She's standing up real
--   per-provider admin accounts on EMS + Riverside instead of using the
--   demo fixtures.
--
--   Removal strategy: archive, not delete. demo-provider-ltd has 13
--   routing_log + 13 enrolments + 13 submissions rows pointing at it via
--   FK; ON DELETE RESTRICT would block a hard delete, and even if cascaded
--   we'd lose audit chain. Archive (active=false + archived_at) flips them
--   out of every "active providers" listing, blocks /provider/ login (the
--   gate rejects archived providers), and preserves the audit trail. Same
--   posture for the other two demos for consistency.
--
--   Provider_users rows for the demos (2 on demo-b2b, 3 on demo-provider-
--   ltd, 0 on demo-b2c) move to status='suspended' so the portal explicitly
--   rejects sign-in attempts. Defence in depth — if the provider-archive
--   check ever regresses, the user-suspended check still holds.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: UPDATEs only. 3 rows in crm.providers, 5 rows in
--      crm.provider_users. No schema change.
--   2. Readers affected: any "active providers" listing in admin UI +
--      Mira's MCP queries. The three demos disappear from those lists.
--   3. Writers affected: routeLead and netlify-employer-lead-router both
--      reject archived providers (provider_inactive outcome). Any future
--      test submission to a demo provider returns a routing error.
--   4. Schema version: no payload change.
--   5. Data migration: none — historical rows in leads.routing_log,
--      crm.enrolments, leads.submissions stay pointing at demo-provider-
--      ltd. Provider lookup will still resolve (active row exists, just
--      archived).
--   6. Role/policy: no change.
--   7. Rollback: UPDATE setting active=true, archived_at=NULL on the
--      three rows + status='active' on the five users. Trivial.
--   8. Sign-off: owner (Charlotte 2026-05-20).
--
-- Related: data-ops 019 (demo-provider-ltd seed), 023 (demo-provider-ltd
--          fresh lead), 035 (demo-b2b seed), 036 (demo-b2c seed)

BEGIN;

UPDATE crm.providers
   SET active      = false,
       archived_at = now(),
       updated_at  = now()
 WHERE provider_id IN ('demo-b2c', 'demo-b2b', 'demo-provider-ltd')
   AND archived_at IS NULL;

UPDATE crm.provider_users
   SET status     = 'suspended',
       updated_at = now()
 WHERE provider_id IN ('demo-b2c', 'demo-b2b', 'demo-provider-ltd')
   AND status     <> 'suspended';

COMMIT;

-- =============================================================================
-- DOWN (manual, if needed)
-- =============================================================================
-- BEGIN;
-- UPDATE crm.providers
--    SET active = true, archived_at = NULL, updated_at = now()
--  WHERE provider_id IN ('demo-b2c', 'demo-b2b', 'demo-provider-ltd');
-- UPDATE crm.provider_users
--    SET status = 'active', updated_at = now()
--  WHERE provider_id IN ('demo-b2c', 'demo-b2b', 'demo-provider-ltd');
-- COMMIT;
