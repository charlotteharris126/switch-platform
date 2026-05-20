-- Data-ops 044 — Backfill audit.actions for historical Riverside routings
-- Date:   2026-05-20
-- Author: Sasha (Charlotte's session)
-- Reason:
--   netlify-employer-lead-router didn't write an audit.actions row for the
--   routing event the way _shared/route-lead.ts (funded flow) does. Live
--   leads.routing_log has 30 Riverside entries with no matching
--   action='auto_route_lead' row in audit.actions, so the admin audit view
--   showed every EMS routing but no Riverside routings.
--
--   The forward fix shipped in this session (employer router now writes
--   the audit row at the end of post-route fan-out). This script
--   backfills the 30 missing historical rows so the audit log is
--   consistent for both providers across all time.
--
--   Backfill shape mirrors the live writer:
--     surface       = 'system'
--     action        = 'auto_route_lead'
--     actor_email   = 'system:auto_route:lead_router (backfill data-ops/044)'
--     target_table  = 'leads.submissions'
--     target_id     = submission.id::text
--     after_value   = { primary_routed_to, routed_at }
--     context       = { trigger, lead_type, provider_id, backfilled: true,
--                       sheet_appended, provider_notified, employer_ack_sent }
--   For backfilled rows, the three outcome booleans are NULL — we don't
--   know what actually happened post-route at the time (the original
--   functions didn't log). created_at is set to routing_log.routed_at so
--   the audit timeline is chronologically faithful.
--
-- Idempotency: NOT EXISTS guard against audit.actions on
-- (target_table='leads.submissions', target_id=submission.id::text,
-- action='auto_route_lead'). Re-running this script is a no-op.
--
-- Impact: ~30 INSERTs into audit.actions. No effect on any other table.
-- Append-only — no UPDATE or DELETE. Cannot retroactively corrupt anything.
--
-- Related: forward fix in platform/supabase/functions/netlify-employer-
--          lead-router/index.ts (Session 55).

BEGIN;

INSERT INTO audit.actions (
  created_at,
  actor_user_id,
  actor_email,
  surface,
  action,
  target_table,
  target_id,
  before_value,
  after_value,
  context
)
SELECT
  rl.routed_at                                                          AS created_at,
  NULL                                                                  AS actor_user_id,
  'system:auto_route:lead_router (backfill data-ops/044)'               AS actor_email,
  'system'                                                              AS surface,
  'auto_route_lead'                                                     AS action,
  'leads.submissions'                                                   AS target_table,
  s.id::text                                                            AS target_id,
  NULL::jsonb                                                           AS before_value,
  jsonb_build_object(
    'primary_routed_to', rl.provider_id,
    'routed_at',         rl.routed_at
  )                                                                     AS after_value,
  jsonb_build_object(
    'trigger',           'auto_route',
    'lead_type',         s.lead_type,
    'provider_id',       rl.provider_id,
    'backfilled',        true,
    'sheet_appended',    NULL,
    'provider_notified', NULL,
    'employer_ack_sent', NULL
  )                                                                     AS context
FROM leads.routing_log rl
JOIN leads.submissions s ON s.id = rl.submission_id
WHERE rl.provider_id = 'riverside-training'
  AND NOT EXISTS (
    SELECT 1
      FROM audit.actions a
     WHERE a.target_table = 'leads.submissions'
       AND a.target_id    = s.id::text
       AND a.action       = 'auto_route_lead'
  );

COMMIT;

-- =============================================================================
-- DOWN (manual)
-- =============================================================================
-- DELETE FROM audit.actions
--  WHERE action       = 'auto_route_lead'
--    AND actor_email  = 'system:auto_route:lead_router (backfill data-ops/044)';
