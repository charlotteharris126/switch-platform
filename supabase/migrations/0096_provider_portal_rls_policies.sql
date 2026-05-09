-- Migration 0096 — Provider portal: RLS policies + helper function
-- Date:    2026-05-09
-- Author:  Claude (platform Session 36) on Charlotte's instruction
-- Reason:  Database-layer enforcement of "EMS can never see WYK's leads".
--          The portal at app.switchleads.co.uk authenticates providers via
--          Supabase Auth (passkey + magic-link recovery). All providers run
--          as the standard `authenticated` role, same as admin. The gate
--          between admin context and provider context is policy-side: admin
--          policies use admin.is_admin(), provider policies use the new
--          crm.provider_user_provider_id() helper introduced here.
--
--          Helper crm.provider_user_provider_id() returns:
--            - The caller's provider_id, IF they have an active row in
--              crm.provider_users AND that provider has portal_enabled=true.
--            - NULL otherwise (locks them out of every provider policy).
--
--          portal_enabled gating is baked into the helper so per-provider
--          cutover (EMS first, then WYK, then Courses Direct) is one-flag
--          on/off, no policy changes per provider. Same row-scoping gate
--          applies to every provider table.
--
--          Tables policy-gated for provider read:
--            - leads.submissions (their leads only via primary_routed_to)
--            - leads.routing_log (their routing events only)
--            - leads.fastrack_submissions (their leads' fastrack rows)
--            - crm.enrolments (their enrolment rows; SELECT + UPDATE)
--            - crm.providers (their own provider row only)
--            - crm.provider_users (their own provider's users only)
--            - crm.disputes (their leads' disputes; SELECT + INSERT)
--
--          UPDATE on crm.enrolments: policy permits the row scope, but
--          server-side app code is responsible for limiting which columns
--          actually get touched (status, status_updated_at, notes, updated_at).
--          Column-level GRANTs are not used because the admin path also
--          needs broader column access on the same role; the server-side
--          Next.js Server Actions are the trust boundary.
--
--          Bulk-deny for everything else: the policies are additive (RLS
--          combines via OR). A provider user is implicitly denied access
--          to any table that doesn't carry a matching provider policy.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: additive only. New helper function, new policies on 7 tables.
--      No data migration. Existing admin / analytics / functions / n8n
--      policies untouched.
--   2. Readers gated by these policies: the portal Server Actions (not yet
--      shipped). No current consumer breaks because none of them run as a
--      provider-context authenticated user yet.
--   3. Writers: provider Server Actions can update crm.enrolments and
--      insert into crm.disputes for their own provider's rows.
--   4. Schema version: no payload contract.
--   5. Data migration: none.
--   6. Role/policy: every provider policy gates on crm.provider_user_provider_id().
--      No new Postgres role created — providers run as `authenticated` like
--      admin, gated by the helper function. Mirrors the admin.is_admin()
--      pattern from migration 0014.
--   7. Rollback: DOWN drops the policies and the helper function. No
--      external dependencies until portal Server Actions ship.
--   8. Sign-off: owner (this session, 2026-05-08/09).
-- Related: migration 0014 (admin.is_admin pattern), 0093 (portal_enabled
--          flag), 0094 (crm.provider_users), 0095 (audit.log_provider_action),
--          platform/docs/provider-portal-mvp-scoping.md

BEGIN;

-- =============================================================================
-- 1. Helper function
-- =============================================================================
-- Returns the provider_id of the caller's provider_users row, NULL if:
--   - caller has no auth.uid() (not signed in)
--   - caller is not in crm.provider_users
--   - caller's provider_users row is not status='active'
--   - the provider's portal_enabled flag is false (per-provider cutover gate)
--
-- STABLE: same input (auth.uid()) returns same output within a single
-- statement. Lets the planner cache this across N row-scans of a SELECT.
-- SECURITY DEFINER: the function reads crm.provider_users + crm.providers,
-- which the caller may not have direct SELECT on (RLS would deny). Defining
-- as SECURITY DEFINER lets it run with the function-owner's privileges
-- (postgres) so it can do the lookup.

CREATE OR REPLACE FUNCTION crm.provider_user_provider_id()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, crm, public
AS $$
DECLARE
  v_provider_id TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT pu.provider_id INTO v_provider_id
    FROM crm.provider_users pu
    JOIN crm.providers p ON p.provider_id = pu.provider_id
   WHERE pu.auth_user_id = auth.uid()
     AND pu.status = 'active'
     AND p.portal_enabled = true
   LIMIT 1;

  RETURN v_provider_id;
END;
$$;

COMMENT ON FUNCTION crm.provider_user_provider_id() IS
  'Returns the provider_id of the caller (auth.uid()) if they are an active provider portal user AND their provider has portal_enabled=true; NULL otherwise. Single source of truth for the provider-context gate. Used by every provider RLS policy on submissions / enrolments / routing_log / fastrack_submissions / providers / provider_users / disputes. Added migration 0096.';

REVOKE ALL ON FUNCTION crm.provider_user_provider_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.provider_user_provider_id() TO authenticated;

-- =============================================================================
-- 2. Provider read policies on the leads schema
-- =============================================================================

-- leads.submissions: provider sees rows where they were the routed provider.
CREATE POLICY provider_read_submissions
  ON leads.submissions
  FOR SELECT TO authenticated
  USING (primary_routed_to = crm.provider_user_provider_id());

-- leads.routing_log: provider sees their own routing events.
CREATE POLICY provider_read_routing_log
  ON leads.routing_log
  FOR SELECT TO authenticated
  USING (provider_id = crm.provider_user_provider_id());

-- leads.fastrack_submissions: provider sees fastrack rows for their leads.
-- Fastrack rows reference parent submissions; scope via parent's primary_routed_to.
CREATE POLICY provider_read_fastrack_submissions
  ON leads.fastrack_submissions
  FOR SELECT TO authenticated
  USING (
    parent_submission_id IN (
      SELECT id FROM leads.submissions
      WHERE primary_routed_to = crm.provider_user_provider_id()
    )
  );

-- =============================================================================
-- 3. Provider read + update policies on crm.enrolments
-- =============================================================================

CREATE POLICY provider_read_enrolments
  ON crm.enrolments
  FOR SELECT TO authenticated
  USING (provider_id = crm.provider_user_provider_id());

-- UPDATE: row-scoped to provider. Server-side app code controls which
-- columns actually move. WITH CHECK enforces the row scope on the post-
-- update value too (so a provider can't UPDATE a row out of their scope
-- by changing provider_id, even though they shouldn't be able to write
-- that column anyway given the standard authenticated grants).
CREATE POLICY provider_update_enrolments
  ON crm.enrolments
  FOR UPDATE TO authenticated
  USING (provider_id = crm.provider_user_provider_id())
  WITH CHECK (provider_id = crm.provider_user_provider_id());

-- =============================================================================
-- 4. Provider read on crm.providers (own row only)
-- =============================================================================

CREATE POLICY provider_read_own_provider
  ON crm.providers
  FOR SELECT TO authenticated
  USING (provider_id = crm.provider_user_provider_id());

-- =============================================================================
-- 5. Provider read on crm.provider_users (their own provider's users)
-- =============================================================================
-- Provider_admin role-checking happens app-side; the SQL policy lets any
-- active provider_user see the roster of users on their provider so the
-- account page can render. Suspended/revoked rows are visible too so the
-- admin user sees the historical picture.

CREATE POLICY provider_read_own_provider_users
  ON crm.provider_users
  FOR SELECT TO authenticated
  USING (provider_id = crm.provider_user_provider_id());

-- =============================================================================
-- 6. Provider read + insert on crm.disputes
-- =============================================================================
-- Dispute is scoped via the related enrolment's provider_id. Subquery
-- through crm.enrolments rather than denormalising provider_id onto the
-- dispute row.

CREATE POLICY provider_read_own_disputes
  ON crm.disputes
  FOR SELECT TO authenticated
  USING (
    enrolment_id IN (
      SELECT id FROM crm.enrolments
      WHERE provider_id = crm.provider_user_provider_id()
    )
  );

CREATE POLICY provider_insert_own_disputes
  ON crm.disputes
  FOR INSERT TO authenticated
  WITH CHECK (
    enrolment_id IN (
      SELECT id FROM crm.enrolments
      WHERE provider_id = crm.provider_user_provider_id()
    )
  );

-- =============================================================================
-- 7. Audit helper grant
-- =============================================================================
-- audit.log_provider_action was created in 0095 with GRANT EXECUTE TO
-- authenticated. No additional grant needed here; the function self-
-- validates that the caller is a provider_users row.

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS provider_insert_own_disputes ON crm.disputes;
-- DROP POLICY IF EXISTS provider_read_own_disputes ON crm.disputes;
-- DROP POLICY IF EXISTS provider_read_own_provider_users ON crm.provider_users;
-- DROP POLICY IF EXISTS provider_read_own_provider ON crm.providers;
-- DROP POLICY IF EXISTS provider_update_enrolments ON crm.enrolments;
-- DROP POLICY IF EXISTS provider_read_enrolments ON crm.enrolments;
-- DROP POLICY IF EXISTS provider_read_fastrack_submissions ON leads.fastrack_submissions;
-- DROP POLICY IF EXISTS provider_read_routing_log ON leads.routing_log;
-- DROP POLICY IF EXISTS provider_read_submissions ON leads.submissions;
-- REVOKE EXECUTE ON FUNCTION crm.provider_user_provider_id() FROM authenticated;
-- DROP FUNCTION IF EXISTS crm.provider_user_provider_id();
-- COMMIT;
