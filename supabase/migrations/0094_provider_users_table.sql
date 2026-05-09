-- Migration 0094 — Provider portal: crm.provider_users table
-- Date:    2026-05-08
-- Author:  Claude (platform Session 36) on Charlotte's instruction
-- Reason:  The mapping between Supabase Auth users and the providers they
--          can act on. Multi-user-per-provider from day one (EMS likely
--          wants Andy + an adviser; Riverside likely Kevin + ops). Single
--          source of truth: this table is the only place "this auth user
--          can act on this provider" lives. App code reads from here, never
--          encodes provider_id in JWT claims, env vars, or config files.
--
--          Role column gates UI permissions:
--            'provider_admin' = full account management (invite users,
--                                manage account settings, mark outcomes)
--            'provider_user'  = mark outcomes only (no account/user mgmt)
--
--          Status column allows soft-disable without DELETE:
--            'active'    = can log in and act
--            'suspended' = temporarily blocked (kept for audit)
--            'revoked'   = permanently blocked (kept for audit + GDPR)
--
--          UNIQUE on auth_user_id: one Supabase Auth account maps to at
--          most one provider in v1. Edge case (one person works for two
--          pilot providers) deferred to v2.
--
--          ON DELETE CASCADE on auth_user_id: if Supabase Auth deletes
--          the user (e.g. GDPR erasure), the provider_users row goes too.
--
--          The Postgres provider_user role + RLS policies that gate
--          provider-side access to OTHER tables (submissions, enrolments,
--          routing_log, disputes) ship in migration 0096.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: additive only. New table + indexes + grants + admin/analytics/
--      functions policies. No data migration; existing rows unaffected.
--   2. Readers: admin dashboard (list users per provider, last-login column
--      on /admin/providers, "providers without recent login" tile).
--      Analytics (Mira via MCP).
--   3. Writers: Edge Function `provider-magic-link` (admin invites a user,
--      Edge Function inserts the row); Edge Function `provider-auth-callback`
--      (updates last_login_at on each successful auth); admin dashboard
--      (manual UPDATE for suspend/revoke).
--   4. Schema version: no payload contract; no version bump.
--   5. Data migration: none.
--   6. Role/policy: standard 3-role pattern (admin / functions_writer /
--      readonly_analytics) on this migration. provider_user role + its
--      policies on this AND other tables ship in 0096.
--   7. Rollback: DOWN drops the table. No external dependencies until
--      0096 + Edge Functions ship.
--   8. Sign-off: owner (this session, 2026-05-08).
-- Related: platform/docs/provider-portal-mvp-scoping.md
--          migration 0093 (added portal_enabled flag this table partners with)

BEGIN;

-- 1. Table
CREATE TABLE crm.provider_users (
  id                BIGSERIAL PRIMARY KEY,
  provider_id       TEXT NOT NULL REFERENCES crm.providers(provider_id) ON DELETE RESTRICT,
  auth_user_id      UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_email     TEXT NOT NULL,
  display_name      TEXT,
  role              TEXT NOT NULL DEFAULT 'provider_admin'
                      CHECK (role IN ('provider_admin', 'provider_user')),
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'suspended', 'revoked')),
  invited_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  invited_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  last_login_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE crm.provider_users IS
  'Supabase Auth user ↔ provider mapping. One row per (auth_user_id) pair. The only place "this auth user can act on this provider" lives. role gates UI permissions; status allows soft-disable. last_login_at is the timestamp the auth-callback Edge Function recorded the most recent successful sign-in. Added migration 0094.';

COMMENT ON COLUMN crm.provider_users.role IS
  'provider_admin = full account management for the provider. provider_user = mark outcomes only. Single source of truth for provider-side permissions; portal UI reads from here.';

COMMENT ON COLUMN crm.provider_users.status IS
  'active = can log in. suspended = temporarily blocked. revoked = permanently blocked. Soft-disable rather than DELETE so the audit chain survives.';

-- 2. Indexes
-- Common reads: "list active users for this provider", "find user by auth id".
-- auth_user_id already has an implicit unique index from the column constraint.
CREATE INDEX provider_users_provider_status_idx
  ON crm.provider_users (provider_id, status);

CREATE INDEX provider_users_last_login_idx
  ON crm.provider_users (last_login_at)
  WHERE last_login_at IS NOT NULL;

-- updated_at is set manually by callers via `updated_at = now()` in UPDATE
-- statements, matching the convention used by crm.providers / crm.enrolments.
-- No trigger to avoid introducing a divergent pattern.

-- 3. RLS + role policies
ALTER TABLE crm.provider_users ENABLE ROW LEVEL SECURITY;

-- Admin (authenticated role + admin.is_admin gate): full access to manage
-- provider users — invite, suspend, revoke, change role.
GRANT SELECT, INSERT, UPDATE, DELETE ON crm.provider_users TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE crm.provider_users_id_seq TO authenticated;

CREATE POLICY admin_all_provider_users
  ON crm.provider_users
  FOR ALL TO authenticated
  USING (admin.is_admin())
  WITH CHECK (admin.is_admin());

-- Edge Functions (functions_writer): provider-magic-link inserts on invite,
-- auth-callback updates last_login_at. ALL is broader than strictly needed
-- but matches the convention from 0087 and avoids a churn migration when
-- a fourth Edge Function path lands.
GRANT SELECT, INSERT, UPDATE ON crm.provider_users TO functions_writer;
GRANT USAGE, SELECT ON SEQUENCE crm.provider_users_id_seq TO functions_writer;

CREATE POLICY functions_all_provider_users
  ON crm.provider_users
  FOR ALL TO functions_writer
  USING (true)
  WITH CHECK (true);

-- Analytics: read-only for Mira, Sasha via MCP, future Metabase.
GRANT SELECT ON crm.provider_users TO readonly_analytics;

CREATE POLICY analytics_read_provider_users
  ON crm.provider_users
  FOR SELECT TO readonly_analytics
  USING (true);

-- The provider_user role + its row-scoped self-read policy on this table
-- ship in migration 0096 (alongside the policies for submissions / enrolments
-- / routing_log / disputes).

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS analytics_read_provider_users ON crm.provider_users;
-- DROP POLICY IF EXISTS functions_all_provider_users ON crm.provider_users;
-- DROP POLICY IF EXISTS admin_all_provider_users ON crm.provider_users;
-- REVOKE ALL ON crm.provider_users FROM readonly_analytics;
-- REVOKE ALL ON crm.provider_users FROM functions_writer;
-- REVOKE ALL ON SEQUENCE crm.provider_users_id_seq FROM functions_writer;
-- REVOKE ALL ON crm.provider_users FROM authenticated;
-- REVOKE ALL ON SEQUENCE crm.provider_users_id_seq FROM authenticated;
-- DROP INDEX IF EXISTS crm.provider_users_last_login_idx;
-- DROP INDEX IF EXISTS crm.provider_users_provider_status_idx;
-- DROP TABLE IF EXISTS crm.provider_users;
-- COMMIT;
