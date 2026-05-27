-- Migration 0175 — GRANT SELECT on crm.sms_log + crm.email_log to authenticated
-- Date: 2026-05-27
-- Author: Claude (Sasha, platform session) with owner sign-off
-- Reason:
--   The /admin/leads page has been silently returning zero rows from
--   crm.sms_log and crm.email_log for the entire deployed history. RLS
--   policies admin_read_sms_log and admin_read_email_log target the
--   `authenticated` role with admin.is_admin() — but neither table had a
--   table-level GRANT SELECT to authenticated. Postgres evaluates GRANT
--   before RLS, so the policy never gets a chance to run; the admin
--   Supabase client (authenticated role + admin JWT) gets a silent empty
--   result with no error surfaced.
--
--   Net effect: the "Last email chaser" and "Last SMS chaser" columns on
--   /admin/leads have always shown "—" for every row, even after dozens of
--   chasers actually fired (verified via service-role queries during
--   Charlotte's 2026-05-27 batch SMS session). Same goes for the U1 column,
--   any /admin/leads/[id] surface reading these logs from the page, and
--   the new "Chased" filter + chaser sort that landed earlier today.
--
--   This is the same RLS-without-GRANT class as migrations 0109/0114
--   (crm.lead_notes) and 0096-0108 (crm.enrolments). The fix is one line
--   per table.
--
-- Related:
--   .claude/rules/data-infrastructure.md §6 (RLS) + §2 (schema discipline)
--   memory: feedback_rls_policy_needs_table_grant.md
--   crm.lead_notes precedent: migration 0114
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: GRANT SELECT on two tables to one role. No DDL on data.
--   2. Readers: /admin/leads page, /admin/leads/[id], any admin surface
--      reading chaser/email/SMS logs as authenticated. RLS still gates
--      to admins only via admin.is_admin().
--   3. Writers: unaffected. functions_writer keeps full ALL grant.
--   4. Schema_version: no contract bumped.
--   5. Data migration: none.
--   6. New role / policy: none — policy already exists, only the GRANT
--      was missing.
--   7. Rollback: REVOKE in the DOWN block.
--   8. Sign-off: owner 2026-05-27.

BEGIN;

GRANT SELECT ON crm.sms_log   TO authenticated;
GRANT SELECT ON crm.email_log TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- REVOKE SELECT ON crm.sms_log   FROM authenticated;
-- REVOKE SELECT ON crm.email_log FROM authenticated;
-- COMMIT;
