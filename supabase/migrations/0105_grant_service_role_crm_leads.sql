-- Migration 0105 — GRANT service_role on crm + leads schemas
-- Date:    2026-05-09
-- Author:  Claude (platform Session 37 / Sasha) on Charlotte's instruction
-- Reason:  Supabase's service_role has rolbypassrls=true (verified) but had
--          NO schema or table privileges on the `crm` and `leads` schemas.
--          Default Supabase setup grants service_role to `public` only;
--          custom schemas need explicit grants, and these never landed for
--          crm/leads when those schemas were created (migrations 0001 onwards).
--
--          The gap was invisible until Session 37 because all admin code
--          authenticates as the `authenticated` role (Supabase login cookies)
--          and `authenticated` was granted per-table by every migration.
--          The new passkey API routes use service_role because they run
--          BEFORE any Supabase session exists (the session is minted as the
--          outcome of /api/passkey/register-verify), so they need a role
--          that bypasses RLS without being a logged-in user.
--
--          Symptom: every API route that called createAdminClient and then
--          .schema("crm").from("provider_users") returned data: null with
--          no error, because service_role had no SELECT privilege. supabase-js
--          surfaces this as an empty result set rather than an explicit
--          permission error, which is what made it look like the row didn't
--          exist (404 user_not_found).
--
--          Fix: GRANT USAGE on the schemas, GRANT ALL on all existing tables
--          and sequences, and ALTER DEFAULT PRIVILEGES so future tables in
--          these schemas auto-grant. Matches what would have been set up at
--          schema-creation time if convention had been followed.
--
--          Also includes the same grants for `audit` schema for symmetry —
--          the audit helper functions (log_provider_action, log_system_action)
--          are SECURITY DEFINER so they don't currently need service_role
--          access, but future audit reads might.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: GRANT USAGE on schemas crm, leads, audit + GRANT ALL on
--      tables/sequences therein to service_role + ALTER DEFAULT PRIVILEGES.
--      No table/column changes, no data migration.
--   2. Readers: every Server Action / API route that uses the service-role
--      Supabase client now sees these schemas. No existing consumers were
--      using service_role on these tables before, so no behaviour change to
--      working code.
--   3. Writers: same.
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role/policy: existing per-table policies (admin_*, functions_*,
--      analytics_*) unchanged. service_role bypasses RLS by virtue of its
--      rolbypassrls attribute; no new policy needed.
--   7. Rollback: REVOKE the same grants. DOWN section below.
--   8. Sign-off: owner (this session, 2026-05-09).
-- Related: 0094, 0102, 0103 (provider_users + provider_passkeys schema), and
--          the broader pattern of every `crm`/`leads` migration declaring
--          per-role grants but consistently omitting service_role.

BEGIN;

-- ============================================================================
-- crm schema
-- ============================================================================
GRANT USAGE ON SCHEMA crm TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA crm TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA crm TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA crm TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm GRANT ALL ON FUNCTIONS TO service_role;

-- ============================================================================
-- leads schema
-- ============================================================================
GRANT USAGE ON SCHEMA leads TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA leads TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA leads TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA leads TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA leads GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA leads GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA leads GRANT ALL ON FUNCTIONS TO service_role;

-- ============================================================================
-- audit schema (symmetry; logging helpers are SECURITY DEFINER but future
-- reads might want service_role access)
-- ============================================================================
GRANT USAGE ON SCHEMA audit TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA audit TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA audit TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA audit TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT ALL ON FUNCTIONS TO service_role;

COMMIT;

-- ============================================================================
-- DOWN
-- ============================================================================
-- BEGIN;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA audit REVOKE ALL ON FUNCTIONS FROM service_role;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA audit REVOKE ALL ON SEQUENCES FROM service_role;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA audit REVOKE ALL ON TABLES FROM service_role;
-- REVOKE ALL ON ALL FUNCTIONS IN SCHEMA audit FROM service_role;
-- REVOKE ALL ON ALL SEQUENCES IN SCHEMA audit FROM service_role;
-- REVOKE ALL ON ALL TABLES IN SCHEMA audit FROM service_role;
-- REVOKE USAGE ON SCHEMA audit FROM service_role;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA leads REVOKE ALL ON FUNCTIONS FROM service_role;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA leads REVOKE ALL ON SEQUENCES FROM service_role;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA leads REVOKE ALL ON TABLES FROM service_role;
-- REVOKE ALL ON ALL FUNCTIONS IN SCHEMA leads FROM service_role;
-- REVOKE ALL ON ALL SEQUENCES IN SCHEMA leads FROM service_role;
-- REVOKE ALL ON ALL TABLES IN SCHEMA leads FROM service_role;
-- REVOKE USAGE ON SCHEMA leads FROM service_role;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA crm REVOKE ALL ON FUNCTIONS FROM service_role;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA crm REVOKE ALL ON SEQUENCES FROM service_role;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA crm REVOKE ALL ON TABLES FROM service_role;
-- REVOKE ALL ON ALL FUNCTIONS IN SCHEMA crm FROM service_role;
-- REVOKE ALL ON ALL SEQUENCES IN SCHEMA crm FROM service_role;
-- REVOKE ALL ON ALL TABLES IN SCHEMA crm FROM service_role;
-- REVOKE USAGE ON SCHEMA crm FROM service_role;
-- COMMIT;
