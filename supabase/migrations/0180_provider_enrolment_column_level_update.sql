-- Migration 0180 — restrict provider UPDATE on crm.enrolments to non-billing columns
-- Date:    2026-06-01
-- Author:  Claude (Sasha, platform Session 62) — pending owner review before ship
-- Reason:  Codex security audit (2026-06-01) found that migration 0108 granted
--          table-wide UPDATE on crm.enrolments to the `authenticated` role.
--          0096 row-scopes via RLS (provider_id = crm.provider_user_provider_id())
--          but column-level access is NOT scoped, and the table carries billing
--          columns: billed_amount, billed_at, paid_at, gocardless_payment_id.
--          Providers hold real Supabase Auth JWTs, so a provider can PATCH
--          PostgREST directly and rewrite their own billing rows, bypassing the
--          Next.js Server Actions that were assumed to be the trust boundary.
--          This is the revenue source-of-truth table, so the exposure is
--          commercial, not theoretical.
--
--          Fix: revoke the blanket UPDATE and re-grant column-level UPDATE on
--          ONLY the columns the provider portal legitimately writes. Verified
--          against both portal write paths in
--          app/app/provider/leads/[id]/actions.ts (markOutcome single, line 159;
--          bulk, line 590): status, lost_reason, outcome_note, status_updated_at,
--          updated_at, callback_requested_at, callback_requested_by.
--          RLS row-scope (0096 provider_update_enrolments) is unchanged.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: REVOKE UPDATE ON crm.enrolments FROM authenticated, then
--      GRANT UPDATE on 7 named columns to authenticated. No data migration.
--   2. Readers/writers affected:
--      - Provider portal Server Actions: unaffected — they only ever set the 7
--        granted columns. Confirmed by reading both update payloads.
--      - Admin app writes (billing, status overrides): use createAdminClient
--        (service role), which is NOT subject to column grants — unaffected.
--      - Edge Functions: write via functions_writer / postgres — unaffected.
--   3. Schema version: not affected (no payload contract change).
--   4. Role/policy: no policy change; the 0096 RLS UPDATE policy still scopes
--      rows. This narrows the GRANT only.
--   5. Data migration: none.
--   6. Rollback: re-grant table-wide UPDATE (the 0108 state). See DOWN.
--   7. Sign-off: OWNER PENDING. Charlotte to review + ship via supabase CLI.
-- Related: 0108 (the blanket grant being narrowed), 0096 (the row-scope policy),
--          0001 (table definition incl. billing columns),
--          0028 (lost_reason / outcome columns).
--
-- Privilege state (verified against live catalog ACLs, 2026-06-01):
--   BEFORE:
--     authenticated    : SELECT (table), UPDATE (table-wide — incl. billing cols)
--     functions_writer : INSERT, SELECT, UPDATE (table) — UNCHANGED by this migration
--   AFTER:
--     authenticated    : SELECT (table), UPDATE (column-level: the 7 below only)
--     functions_writer : INSERT, SELECT, UPDATE (table) — UNCHANGED
--
-- Write-path verification (all confirmed safe under the narrowed grant):
--   - Portal single + bulk outcome updates: write ONLY the 7 granted columns
--     (actions.ts:159, :590). OK.
--   - Callback flagging: provider only ever CLEARS callback_requested_at/_by
--     (both granted). Raising is admin-side via service role. OK.
--   - Sheet sync (sheet-edit-mirror, reconcile-sheet-to-db): write enrolments
--     via `SET LOCAL ROLE functions_writer`, not authenticated. UNAFFECTED.
--   - Admin app billing/status writes: via createAdminClient (service role).
--     Service role is not subject to column grants. UNAFFECTED.
--   - DB functions touching enrolments (ensure_open_enrolment,
--     upsert_enrolment_outcome, resolve_pending_update, fire_*_chaser,
--     run_enrolment_auto_flip, retention anonymisers): ALL SECURITY DEFINER,
--     so they execute as owner and bypass caller column grants. There is NO
--     SECURITY INVOKER function that updates enrolments. UNAFFECTED.

-- UP

-- Drop the table-wide UPDATE from 0108. Column grants below replace it.
REVOKE UPDATE ON crm.enrolments FROM authenticated;

-- Re-grant UPDATE on ONLY the provider-writable outcome columns. Any column
-- not listed here (billed_amount, billed_at, paid_at, gocardless_payment_id,
-- provider_id, submission_id, routing_log_id, sent_to_provider_at, etc.) is
-- now un-writable by the authenticated role. RLS still scopes which rows.
GRANT UPDATE (
  status,
  lost_reason,
  outcome_note,
  status_updated_at,
  updated_at,
  callback_requested_at,
  callback_requested_by
) ON crm.enrolments TO authenticated;

-- DOWN
-- REVOKE UPDATE (status, lost_reason, outcome_note, status_updated_at,
--   updated_at, callback_requested_at, callback_requested_by)
--   ON crm.enrolments FROM authenticated;
-- GRANT UPDATE ON crm.enrolments TO authenticated;  -- restores 0108 blanket grant
