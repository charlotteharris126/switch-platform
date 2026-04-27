-- Migration 0014 — admin dashboard read access via RLS
-- Date: 2026-04-24
-- Author: Claude (platform Session B) with owner review
-- Reason: The admin dashboard (admin.switchleads.co.uk) authenticates internal users
--         through Supabase Auth (email + password + TOTP). Those users log in as the
--         `authenticated` Postgres role with no SELECT grants on leads.* / crm.* tables.
--         This migration adds a SQL helper `admin.is_admin()` that returns true when
--         the currently-authenticated JWT email is on the allowlist, plus per-table
--         SELECT policies that use it. Admin-role only at this stage — Phase 4 provider
--         policies (`provider_id = auth.uid()`) are added later, side-by-side.
-- Related: platform/docs/admin-dashboard-scoping.md § MVP scope feature 2,
--          platform/docs/current-handoff.md Session B.

-- UP

-- Create the admin namespace + helper function.
CREATE SCHEMA IF NOT EXISTS admin;

-- Helper: is the current authenticated user on the admin allowlist?
-- Allowlist lives inside the function body (single source of truth in the DB). To
-- add / remove an admin, ship a forward migration that replaces this function.
-- This mirrors the `ADMIN_ALLOWLIST` env var on Netlify but does NOT depend on it —
-- the DB must decide access independently of app-layer config.
CREATE OR REPLACE FUNCTION admin.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(
    (auth.jwt() ->> 'email') = ANY (ARRAY[
      'charlotte@switchleads.co.uk'
    ]),
    false
  );
$$;

REVOKE ALL ON FUNCTION admin.is_admin() FROM public;
GRANT EXECUTE ON FUNCTION admin.is_admin() TO authenticated;

-- leads.submissions — full read for admins.
CREATE POLICY admin_read_submissions ON leads.submissions
  FOR SELECT TO authenticated
  USING (admin.is_admin());

-- leads.routing_log
CREATE POLICY admin_read_routing_log ON leads.routing_log
  FOR SELECT TO authenticated
  USING (admin.is_admin());

-- leads.dead_letter
CREATE POLICY admin_read_dead_letter ON leads.dead_letter
  FOR SELECT TO authenticated
  USING (admin.is_admin());

-- leads.partials
CREATE POLICY admin_read_partials ON leads.partials
  FOR SELECT TO authenticated
  USING (admin.is_admin());

-- leads.gateway_captures
CREATE POLICY admin_read_gateway_captures ON leads.gateway_captures
  FOR SELECT TO authenticated
  USING (admin.is_admin());

-- crm.providers
CREATE POLICY admin_read_providers ON crm.providers
  FOR SELECT TO authenticated
  USING (admin.is_admin());

-- crm.provider_courses
CREATE POLICY admin_read_provider_courses ON crm.provider_courses
  FOR SELECT TO authenticated
  USING (admin.is_admin());

-- crm.enrolments
CREATE POLICY admin_read_enrolments ON crm.enrolments
  FOR SELECT TO authenticated
  USING (admin.is_admin());

-- crm.disputes
CREATE POLICY admin_read_disputes ON crm.disputes
  FOR SELECT TO authenticated
  USING (admin.is_admin());

-- Grant USAGE on the schemas so `authenticated` can even see them to read.
-- (RLS still gates the row access — USAGE alone does not expose data.)
GRANT USAGE ON SCHEMA leads TO authenticated;
GRANT USAGE ON SCHEMA crm TO authenticated;
GRANT USAGE ON SCHEMA admin TO authenticated;

-- Grant table-level SELECT so Postgres permits the query before RLS runs.
-- RLS policies above still filter rows; only admins see anything.
GRANT SELECT ON leads.submissions       TO authenticated;
GRANT SELECT ON leads.routing_log       TO authenticated;
GRANT SELECT ON leads.dead_letter       TO authenticated;
GRANT SELECT ON leads.partials          TO authenticated;
GRANT SELECT ON leads.gateway_captures  TO authenticated;
GRANT SELECT ON crm.providers           TO authenticated;
GRANT SELECT ON crm.provider_courses    TO authenticated;
GRANT SELECT ON crm.enrolments          TO authenticated;
GRANT SELECT ON crm.disputes            TO authenticated;

-- DOWN
-- DROP POLICY admin_read_submissions      ON leads.submissions;
-- DROP POLICY admin_read_routing_log      ON leads.routing_log;
-- DROP POLICY admin_read_dead_letter      ON leads.dead_letter;
-- DROP POLICY admin_read_partials         ON leads.partials;
-- DROP POLICY admin_read_gateway_captures ON leads.gateway_captures;
-- DROP POLICY admin_read_providers        ON crm.providers;
-- DROP POLICY admin_read_provider_courses ON crm.provider_courses;
-- DROP POLICY admin_read_enrolments       ON crm.enrolments;
-- DROP POLICY admin_read_disputes         ON crm.disputes;
-- REVOKE SELECT ON leads.submissions, leads.routing_log, leads.dead_letter,
--                  leads.partials, leads.gateway_captures,
--                  crm.providers, crm.provider_courses, crm.enrolments, crm.disputes
--   FROM authenticated;
-- REVOKE USAGE ON SCHEMA leads, crm, admin FROM authenticated;
-- DROP FUNCTION admin.is_admin();
-- DROP SCHEMA admin;
