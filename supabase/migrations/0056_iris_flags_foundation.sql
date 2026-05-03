-- Migration 0056 — Iris stage 1a: ads_switchable.iris_flags table + iris_writer role
-- Date: 2026-05-03
-- Author: Claude (Sasha session) with owner review
-- Reason: Foundation table for the new ads dashboard architecture. Replaces the
--   prior approach where Iris wrote weekly markdown briefs to iCloud (which
--   the owner does not review day-to-day) with a single source-of-truth table
--   the dashboard can render from. Stage 2 (`iris-daily-flags` Edge Function)
--   writes here daily; stage 3 (Action Centre integration) and stage 4
--   (`/admin/ads` Signals card) read from here. This migration ships the
--   schema only — no Edge Function or dashboard code yet.
--
--   New `iris_writer` Postgres role per `.claude/rules/data-infrastructure.md`
--   §11: every consumer of the DB gets its own scoped role with only the
--   permissions it needs. iris_writer can INSERT into iris_flags and SELECT
--   from the source tables it needs to compute flags. No other access.
--
--   v_ad_to_routed and v_ad_baselines (stage 1b and 1c, not yet built) will
--   add their own SELECT grants to iris_writer in their own migrations.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new table `ads_switchable.iris_flags` + indexes + RLS policies
--      + new role `iris_writer` with scoped grants.
--   2. Readers affected: none yet — table is empty until stage 2 ships. Future
--      readers: dashboard `/admin` (Action Centre, stage 3) and `/admin/ads`
--      Signals card (stage 4). Both via the existing `authenticated` role.
--   3. Writers: only the future `iris-daily-flags` Edge Function (stage 2),
--      via the new `iris_writer` role. Owner cannot accidentally write here
--      from the dashboard — RLS denies authenticated INSERT.
--   4. Schema version: new table at v1.0. Existing schemas unaffected.
--   5. Data migration: none.
--   6. New role/policy: yes — `iris_writer` role + `admin_read_iris_flags`
--      SELECT policy + `iris_writer_insert_iris_flags` INSERT policy.
--   7. Rollback: revoke + drop in DOWN.
--   8. Sign-off: owner (this session).
--
-- Related:
--   ClickUp 869d4vty3 (Iris stage 1a)
--   switchable/ads/docs/ads-dashboard-scope.md (full 5-stage scope)
--   switchable/ads/docs/iris-automation-spec.md (threshold spec for stage 2)
--   platform/docs/data-architecture.md (will be updated in same session)
--   platform/supabase/migrations/0050_admin_read_meta_daily.sql (mirrors RLS pattern)
-- =============================================================================

BEGIN;

-- 1. Table
CREATE TABLE ads_switchable.iris_flags (
  id                BIGSERIAL PRIMARY KEY,
  flagged_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  automation        TEXT NOT NULL,
  ad_id             TEXT,
  ad_name           TEXT,
  campaign_id       TEXT,
  campaign_name     TEXT,
  brand             TEXT NOT NULL DEFAULT 'switchable',
  metric_value      NUMERIC NOT NULL,
  threshold         NUMERIC NOT NULL,
  severity          TEXT NOT NULL,
  suggested_action  TEXT NOT NULL,
  notified          BOOLEAN NOT NULL DEFAULT true,
  details           JSONB,
  read_by_owner_at  TIMESTAMPTZ,
  schema_version    TEXT NOT NULL DEFAULT '1.0',
  -- Soft validation; the Edge Function is the canonical writer and constrains
  -- these values upstream. CHECK here defends against direct SQL writes.
  CONSTRAINT iris_flags_severity_check
    CHECK (severity IN ('amber', 'red')),
  CONSTRAINT iris_flags_automation_check
    CHECK (automation IN ('P1.2', 'P2.1', 'P2.2', 'P2.3'))
);

COMMENT ON TABLE ads_switchable.iris_flags IS
  'Single source of truth for Iris flag output. Written by iris-daily-flags Edge Function (stage 2, not yet built); read by Action Centre (stage 3) and /admin/ads Signals card (stage 4). One row per (ad_id, automation) detection event; suppression via notified=false on duplicates within 7 days. Owner clears flags via UPDATE read_by_owner_at = now() from the dashboard. Migration 0056 (stage 1a).';

-- 2. Indexes
-- Ad-history lookup: per-ad drill-down + per-automation history. Frequent.
CREATE INDEX ON ads_switchable.iris_flags (brand, ad_id, automation, flagged_at);

-- Action Centre query: open (unread) notified flags ordered for display.
-- Partial index keeps it tiny — only the actively-surfaced rows.
CREATE INDEX ON ads_switchable.iris_flags (notified, read_by_owner_at)
  WHERE notified = true AND read_by_owner_at IS NULL;

-- 3. Role: iris_writer (scoped per data-infrastructure rule §11)
-- Created BEFORE the policies that reference it; CREATE POLICY ... TO <role>
-- requires the role to exist at parse time.
-- Password placeholder is replaced inline by the owner before apply (use
-- `openssl rand -base64 32`). After apply, revert this line back to
-- '<PASSWORD_IRIS_WRITER>' so the file is safe to commit; canonical password
-- lives in LastPass + logged in platform/docs/secrets-rotation.md.
CREATE ROLE iris_writer WITH LOGIN PASSWORD '<PASSWORD_IRIS_WRITER>';

-- 4. Row Level Security
ALTER TABLE ads_switchable.iris_flags ENABLE ROW LEVEL SECURITY;

-- Read access for the dashboard. Auth gate to the dashboard itself is enforced
-- upstream by the ADMIN_ALLOWLIST middleware (mirrors the migration 0050
-- pattern on meta_daily); rejecting non-admin authenticated users at the DB
-- layer is therefore unnecessary.
CREATE POLICY admin_read_iris_flags
  ON ads_switchable.iris_flags
  FOR SELECT
  TO authenticated
  USING (true);

-- Owner clears flags via the dashboard. Same auth-gate logic as read.
CREATE POLICY admin_update_iris_flags
  ON ads_switchable.iris_flags
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Edge Function writes. iris_writer role only.
CREATE POLICY iris_writer_insert_iris_flags
  ON ads_switchable.iris_flags
  FOR INSERT
  TO iris_writer
  WITH CHECK (true);

GRANT USAGE ON SCHEMA ads_switchable TO iris_writer;
GRANT INSERT ON ads_switchable.iris_flags TO iris_writer;
GRANT USAGE, SELECT ON SEQUENCE ads_switchable.iris_flags_id_seq TO iris_writer;

-- Source tables iris_writer needs to read to compute flags. Stages 1b
-- (v_ad_to_routed) and 1c (v_ad_baselines) will add their own grants in their
-- migrations; granting up-front would error since those views don't exist.
GRANT SELECT ON ads_switchable.meta_daily TO iris_writer;
GRANT USAGE ON SCHEMA leads TO iris_writer;
GRANT SELECT ON leads.submissions TO iris_writer;
GRANT SELECT ON leads.routing_log TO iris_writer;

-- 5. Grants for the dashboard reader (`authenticated` already has USAGE on
-- ads_switchable from migration 0050).
GRANT SELECT, UPDATE ON ads_switchable.iris_flags TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- REVOKE SELECT, UPDATE ON ads_switchable.iris_flags FROM authenticated;
-- REVOKE SELECT ON leads.routing_log FROM iris_writer;
-- REVOKE SELECT ON leads.submissions FROM iris_writer;
-- REVOKE USAGE ON SCHEMA leads FROM iris_writer;
-- REVOKE SELECT ON ads_switchable.meta_daily FROM iris_writer;
-- REVOKE USAGE, SELECT ON SEQUENCE ads_switchable.iris_flags_id_seq FROM iris_writer;
-- REVOKE INSERT ON ads_switchable.iris_flags FROM iris_writer;
-- REVOKE USAGE ON SCHEMA ads_switchable FROM iris_writer;
-- DROP ROLE iris_writer;
-- DROP POLICY iris_writer_insert_iris_flags ON ads_switchable.iris_flags;
-- DROP POLICY admin_update_iris_flags ON ads_switchable.iris_flags;
-- DROP POLICY admin_read_iris_flags ON ads_switchable.iris_flags;
-- DROP TABLE ads_switchable.iris_flags;
-- COMMIT;
