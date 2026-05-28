-- Migration 0177 — strategy.roadmap_tasks: lane + lane_sort_order + target_milestone + admin GRANT
-- Date: 2026-05-28
-- Author: Claude (Sasha, platform session) with owner sign-off
-- Reason:
--   Mira's /admin/roadmap MVP spec (`platform/docs/admin-roadmap-spec.md`)
--   was updated 2026-05-25 with a two-tier hierarchy: 5 Phase-1 LANES on
--   top, revenue_model on second tier. The existing `strategy.roadmap_tasks`
--   table predates this update — it has revenue_model but no lane / sort.
--
--   Additionally, the policy `roadmap_tasks_admin_all` (TO authenticated)
--   was created without a matching table-level GRANT — same silent-empty
--   class as 0114 (crm.lead_notes) and 0175 (crm.sms_log + email_log). The
--   /admin/roadmap page would have rendered zero rows under any admin
--   session until this lands.
--
--   Backfill heuristic for the existing 101 rows assigns each task to the
--   lane that matches its revenue_model. Charlotte can override per-task
--   via the UI; Mira can reseed later if she wants to refine. Already-
--   `complete` tasks all land in lane = 'complete' (lane_sort_order 100)
--   so they sink to the bottom of the roadmap view by default.
--
-- Related:
--   platform/docs/admin-roadmap-spec.md (Mira, 2026-05-23 / -25)
--   strategy/docs/build-map.md "Phase 1 — top-level view"
--   memory: feedback_rls_policy_needs_table_grant.md
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: three new columns + GRANT to authenticated + CHECK
--      constraint + index on lane. No DDL on data outside the new
--      columns.
--   2. Readers: new /admin/roadmap page (this session). Mira via
--      readonly_analytics MCP (already had SELECT).
--   3. Writers: new /admin/roadmap server actions (this session). Owner
--      only via admin.is_admin() RLS.
--   4. Schema_version: additive — no bump. New columns are additive on a
--      table-only-internal contract.
--   5. Data migration: heuristic backfill from revenue_model. Reversible
--      by reassigning lane via UI / SQL later if Mira disagrees.
--   6. New role / policy: GRANT only. Policy already exists from the
--      table's original creation.
--   7. Rollback: DROP COLUMNs in DOWN block. GRANT revoke too.
--   8. Sign-off: owner 2026-05-28.

BEGIN;

ALTER TABLE strategy.roadmap_tasks
  ADD COLUMN lane             TEXT,
  ADD COLUMN lane_sort_order  INTEGER,
  ADD COLUMN target_milestone TEXT;

-- Backfill heuristic. Complete tasks → 'complete' lane regardless of model.
-- Active tasks land in the lane that matches their revenue_model.
UPDATE strategy.roadmap_tasks
   SET lane = CASE
     WHEN status = 'complete'                                 THEN 'complete'
     WHEN revenue_model IN ('provider', 'apprenticeship')     THEN 'per-enrolment-scale'
     WHEN revenue_model IN ('affiliate', 'ppl')               THEN 'affiliate-stack'
     WHEN revenue_model IN ('newsletter-sponsorship', 'placements') THEN 'audience-build'
     WHEN revenue_model = 'whitelabel'                        THEN 'provider-os'
     WHEN revenue_model IN ('app', 'report')                  THEN 'deferred-phase-2'
     WHEN revenue_model = 'foundation'                        THEN 'operational-backbone'
     ELSE                                                          'operational-backbone'
   END;

UPDATE strategy.roadmap_tasks
   SET lane_sort_order = CASE lane
     WHEN 'per-enrolment-scale'    THEN 1
     WHEN 'provider-os'            THEN 2
     WHEN 'affiliate-stack'        THEN 3
     WHEN 'audience-build'         THEN 4
     WHEN 'operational-backbone'   THEN 5
     WHEN 'deferred-phase-2'       THEN 99
     WHEN 'complete'               THEN 100
   END;

ALTER TABLE strategy.roadmap_tasks
  ALTER COLUMN lane            SET NOT NULL,
  ALTER COLUMN lane_sort_order SET NOT NULL;

ALTER TABLE strategy.roadmap_tasks
  ADD CONSTRAINT roadmap_tasks_lane_check CHECK (
    lane IN (
      'per-enrolment-scale',
      'provider-os',
      'affiliate-stack',
      'audience-build',
      'operational-backbone',
      'deferred-phase-2',
      'complete'
    )
  );

CREATE INDEX IF NOT EXISTS idx_roadmap_lane
  ON strategy.roadmap_tasks (lane);

-- Missing GRANT — policy roadmap_tasks_admin_all already exists but the
-- table-level GRANT was never set, so the admin Supabase client (authenticated
-- + admin JWT) gets a silent empty result on SELECT.
GRANT SELECT, INSERT, UPDATE ON strategy.roadmap_tasks TO authenticated;

COMMENT ON COLUMN strategy.roadmap_tasks.lane IS
  'Phase-1 top-level lane grouping. 5 lanes + deferred + complete. See platform/docs/admin-roadmap-spec.md.';
COMMENT ON COLUMN strategy.roadmap_tasks.lane_sort_order IS
  'UI sort order across lanes. 1-5 = active Phase-1 lanes, 99 = deferred, 100 = complete (sinks to bottom).';
COMMENT ON COLUMN strategy.roadmap_tasks.target_milestone IS
  'Optional free-text Phase-1 goal this task contributes to. Surfaced as a tooltip / footnote in the UI.';

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- REVOKE SELECT, INSERT, UPDATE ON strategy.roadmap_tasks FROM authenticated;
-- DROP INDEX IF EXISTS strategy.idx_roadmap_lane;
-- ALTER TABLE strategy.roadmap_tasks DROP CONSTRAINT IF EXISTS roadmap_tasks_lane_check;
-- ALTER TABLE strategy.roadmap_tasks
--   DROP COLUMN IF EXISTS target_milestone,
--   DROP COLUMN IF EXISTS lane_sort_order,
--   DROP COLUMN IF EXISTS lane;
-- COMMIT;
