-- Data-ops 037 — backfill Daniel Mearns' SLA-acceptance audit row
-- Date:   2026-05-15
-- Owner:  Charlotte
-- Reason:
--   Daniel accepted the SLA at 15:26:24 today via the welcome-deck
--   final slide. crm.provider_users.sla_accepted_at + sla_accepted_version
--   were written correctly (visible on his row). But the audit write
--   silently failed because the Server Action called the audit RPC via
--   the admin (service-role) client, which has NULL auth.uid(), and
--   audit.log_provider_action explicitly rejects that.
--
--   Bug fixed in commit c5f62c2 (Server Action now calls the RPC via
--   the authenticated supabase client). Subsequent acceptances will
--   land audit rows correctly.
--
--   This script writes the missing row for Daniel directly so the
--   audit trail has continuity. Uses INSERT INTO audit.actions
--   directly rather than the RPC, because the RPC would still fail
--   if run from a script (no JWT context).
--
-- Related:
--   - platform/app/app/provider/welcome/actions.ts (Server Action)
--   - platform/app/app/provider/sla-agreement/actions.ts (standalone)
--   - audit.log_provider_action (signed-DEFINER fn, requires auth.uid)

BEGIN;

INSERT INTO audit.actions (
  actor_user_id,
  actor_email,
  surface,
  action,
  target_table,
  target_id,
  before_value,
  after_value,
  context,
  created_at
) VALUES (
  '806d92bf-a5f4-4e71-ac52-b372a602b3ba'::uuid,
  'daniel.mearns@enterprisemadesimple.co.uk',
  'provider',
  'accept_sla',
  'crm.provider_users',
  '9',
  NULL,
  jsonb_build_object(
    'sla_accepted_at',      '2026-05-15T15:26:24.466Z',
    'sla_accepted_version', 'v1-2026-05-12'
  ),
  jsonb_build_object(
    'provider_user_id',         9,
    'provider_id',              'enterprise-made-simple',
    'role',                     'provider_admin',
    'accepted_by_auth_user_id', '806d92bf-a5f4-4e71-ac52-b372a602b3ba',
    'via',                      'welcome_deck_final_slide',
    'actor_provider_id',        'enterprise-made-simple',
    'backfilled',               true,
    'backfill_reason',          'Original Server Action called audit RPC via admin client (NULL auth.uid). Fixed in commit c5f62c2. This row replays the acceptance.',
    'backfill_source',          'data_ops:037_backfill_audit_daniel_sla_2026_05_15'
  ),
  '2026-05-15T15:26:24.466Z'::timestamptz
);

-- Verification.
SELECT id, action, target_table, target_id, actor_email, surface, created_at
  FROM audit.actions
 WHERE action = 'accept_sla' AND target_id = '9';

COMMIT;
