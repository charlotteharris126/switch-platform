-- Migration 0051 — admin UPDATE access on leads.dead_letter
-- Date: 2026-05-02
-- Author: Claude (Session 23) with owner review
-- Reason: The Errors page Mark resolved button calls supabase.update on
-- leads.dead_letter from a Server Action running as the `authenticated`
-- role. Migration 0014 only granted SELECT, no UPDATE. Postgres RLS on
-- a missing-policy UPDATE silently filters all rows — no error, just 0
-- rows affected. The Server Action saw error=null and returned ok=true,
-- toast said "Marked resolved", row stayed put.
--
-- Fix: grant UPDATE to authenticated and add an admin_update_dead_letter
-- policy gated on admin.is_admin(). Pattern mirrors the existing
-- admin_read_* SELECT policies.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: TABLE GRANT UPDATE + RLS UPDATE policy on leads.dead_letter
--      for the authenticated role. Gated by admin.is_admin() so only
--      allowlisted owners can mark rows resolved.
--   2. Readers affected: none (read path unchanged).
--   3. Writers affected: dashboard Server Action `markErrorResolved` and
--      `bulkMarkSourceResolved`. n8n_writer FOR ALL policy unchanged.
--   4. Schema version: not affected (no payload contract change).
--   5. Data migration: none.
--   6. New role/policy: yes, admin_update_dead_letter UPDATE policy.
--   7. Rollback: drop policy + revoke UPDATE in DOWN.
--   8. Sign-off: owner (this session).
--
-- Related:
--   platform/supabase/migrations/0014_admin_dashboard_read_access.sql
--   platform/app/app/admin/errors/actions.ts
--   platform/docs/changelog.md — Session 23 entry

-- UP

GRANT UPDATE ON leads.dead_letter TO authenticated;

CREATE POLICY admin_update_dead_letter
  ON leads.dead_letter
  FOR UPDATE
  TO authenticated
  USING (admin.is_admin())
  WITH CHECK (admin.is_admin());

-- DOWN
-- DROP POLICY IF EXISTS admin_update_dead_letter ON leads.dead_letter;
-- REVOKE UPDATE ON leads.dead_letter FROM authenticated;
