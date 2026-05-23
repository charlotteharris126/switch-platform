-- Migration 0160 — Create strategy schema + roadmap_tasks table
-- Date: 2026-05-23
-- Author: Claude (Sasha / platform Session 58) on Mira's PUSH from strategy Session 16
-- Reason: Owner-facing interactive task tracker for the 2026-05-23 audience-business
--   pivot build sequence. Replaces the static HTML at strategy/roadmap.html and
--   moves strategic tracking off ClickUp (which is drowning in operational task noise).
--   Charlotte ticks tasks off as she completes them, adds notes per task, Mira reads
--   the table via MCP each weekly review for continuity.
--
--   Design doc: platform/docs/data-architecture.md (Schema: strategy section, added
--   in same edit). Strategic context: strategy/docs/audience-business-pivot.md,
--   strategy/docs/product-and-revenue-map.md, strategy/docs/build-map.md.
--   Spec: platform/docs/admin-roadmap-spec.md.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new schema `strategy` (first table); new table `strategy.roadmap_tasks`;
--      three indexes (revenue_model, phase, status); RLS policies for authenticated
--      (admin-gated, ALL operations) and readonly_analytics (SELECT only); table-level
--      GRANTs to match.
--   2. Readers affected: future /admin/roadmap admin page (Mable, not yet built);
--      Mira's weekly-review MCP query path (uses readonly_analytics).
--   3. Writers affected: /admin/roadmap admin page (Mable) only; no other consumer.
--   4. Schema version: table carries `schema_version` column defaulting to '1.0'
--      per .claude/rules/schema-versioning.md. This is the v1 of the strategy tracker
--      contract.
--   5. Data migration: none here. Seed data lands in 0161 (separate migration so
--      schema-only 0160 can be re-applied independently and seed can be extended).
--   6. Role / policy: adds `roadmap_tasks_admin_all` (ALL on authenticated, admin-gated)
--      and `roadmap_tasks_readonly_select` (SELECT on readonly_analytics). Standard
--      pattern, mirrors leads.* / crm.* admin RLS.
--   7. Rollback: DOWN drops the table, both policies, the schema (CASCADE).
--   8. Sign-off: owner (Charlotte) via strategy Session 16 (2026-05-23) lock of
--      "/admin/roadmap MVP added as Week 1-2 priority" decision.

BEGIN;

-- =============================================================================
-- Schema
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS strategy;
COMMENT ON SCHEMA strategy IS 'Owner-facing strategic state: roadmap tasks, future strategic tracking surfaces. Read-only to Mira via MCP.';

-- =============================================================================
-- Table
-- =============================================================================

CREATE TABLE strategy.roadmap_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  description     TEXT,
  revenue_model   TEXT NOT NULL,
  phase           TEXT NOT NULL,
  agent_tags      TEXT[] NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'to_do',
  notes           TEXT,
  sort_order      INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  schema_version  TEXT NOT NULL DEFAULT '1.0',

  CONSTRAINT roadmap_tasks_revenue_model_check CHECK (revenue_model IN (
    'foundation', 'provider', 'apprenticeship', 'affiliate', 'ppl',
    'app', 'newsletter-sponsorship', 'placements', 'report', 'whitelabel'
  )),
  CONSTRAINT roadmap_tasks_phase_check CHECK (phase IN ('p1', 'p2', 'p3', 'p4')),
  CONSTRAINT roadmap_tasks_status_check CHECK (status IN (
    'to_do', 'in_progress', 'blocked', 'review', 'complete'
  ))
);

COMMENT ON TABLE strategy.roadmap_tasks IS
  'Interactive task tracker for the 2026 audience-business pivot build sequence. '
  'Replaces strategy/roadmap.html. Owner-only writes via /admin/roadmap. '
  'Mira reads via readonly_analytics MCP for weekly review.';

-- Indexes
CREATE INDEX roadmap_tasks_revenue_model_idx ON strategy.roadmap_tasks (revenue_model);
CREATE INDEX roadmap_tasks_phase_idx         ON strategy.roadmap_tasks (phase);
CREATE INDEX roadmap_tasks_status_idx        ON strategy.roadmap_tasks (status);

-- Auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION strategy.roadmap_tasks_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  IF NEW.status = 'complete' AND OLD.status <> 'complete' THEN
    NEW.completed_at = NOW();
  ELSIF NEW.status <> 'complete' THEN
    NEW.completed_at = NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER roadmap_tasks_touch_updated_at_trg
  BEFORE UPDATE ON strategy.roadmap_tasks
  FOR EACH ROW EXECUTE FUNCTION strategy.roadmap_tasks_touch_updated_at();

-- =============================================================================
-- RLS
-- =============================================================================

ALTER TABLE strategy.roadmap_tasks ENABLE ROW LEVEL SECURITY;

-- Owner (admin) gets full access via authenticated role + admin.is_admin() gate.
-- Same pattern as admin-dashboard tables (see migration 0090 for fastrack_submissions).
CREATE POLICY roadmap_tasks_admin_all ON strategy.roadmap_tasks
  FOR ALL TO authenticated
  USING (admin.is_admin())
  WITH CHECK (admin.is_admin());

GRANT USAGE ON SCHEMA strategy TO authenticated;
GRANT ALL ON strategy.roadmap_tasks TO authenticated;

-- Mira reads via readonly_analytics MCP
CREATE POLICY roadmap_tasks_readonly_select ON strategy.roadmap_tasks
  FOR SELECT TO readonly_analytics
  USING (TRUE);

GRANT USAGE ON SCHEMA strategy TO readonly_analytics;
GRANT SELECT ON strategy.roadmap_tasks TO readonly_analytics;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- REVOKE SELECT ON strategy.roadmap_tasks FROM readonly_analytics;
-- REVOKE USAGE ON SCHEMA strategy FROM readonly_analytics;
-- REVOKE ALL ON strategy.roadmap_tasks FROM authenticated;
-- REVOKE USAGE ON SCHEMA strategy FROM authenticated;
-- DROP POLICY IF EXISTS roadmap_tasks_readonly_select ON strategy.roadmap_tasks;
-- DROP POLICY IF EXISTS roadmap_tasks_admin_all ON strategy.roadmap_tasks;
-- DROP TRIGGER IF EXISTS roadmap_tasks_touch_updated_at_trg ON strategy.roadmap_tasks;
-- DROP FUNCTION IF EXISTS strategy.roadmap_tasks_touch_updated_at();
-- DROP TABLE IF EXISTS strategy.roadmap_tasks;
-- DROP SCHEMA IF EXISTS strategy CASCADE;
-- COMMIT;
