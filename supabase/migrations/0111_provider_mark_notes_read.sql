-- Migration 0111 — provider can UPDATE read_by_provider_at on lead_notes
-- Date:    2026-05-10
-- Author:  Claude (platform Session 39) on Charlotte's instruction
-- Reason:  0110 added read_by_provider_at to crm.lead_notes for the
--          unread-admin-notes indicator. The provider portal needs to
--          flip null → now() when the provider opens the lead detail
--          page. Column-scoped UPDATE grant + a matching RLS policy
--          covers exactly that operation, no broader writes.
-- Impact: additive grant + policy, no other consumers affected.
-- Sign-off: owner (this session, 2026-05-10).

GRANT UPDATE (read_by_provider_at) ON crm.lead_notes TO authenticated;

CREATE POLICY provider_update_read_state_lead_notes
  ON crm.lead_notes
  FOR UPDATE TO authenticated
  USING (provider_id = crm.provider_user_provider_id())
  WITH CHECK (provider_id = crm.provider_user_provider_id());

-- DOWN
-- DROP POLICY IF EXISTS provider_update_read_state_lead_notes ON crm.lead_notes;
-- REVOKE UPDATE (read_by_provider_at) ON crm.lead_notes FROM authenticated;
