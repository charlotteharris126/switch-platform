-- Migration 0209 — retire the Riverside provider sheet (stop the drift check)
-- Date: 2026-06-14
-- Author: Claude (Sasha session) with owner sign-off
-- Reason: Riverside Training is portal-only and never uses their Google sheet,
--   yet sheet-drift-reconcile-daily loops over every active provider with a
--   sheet_webhook_url set (index.ts: WHERE active = true AND sheet_webhook_url
--   IS NOT NULL) and logs a sheet_drift_detected dead_letter row each morning.
--   Result: recurring Riverside "drift" noise that can never resolve because
--   nobody republishes to a sheet they don't use. Mira's call 2026-06-14:
--   don't build auto-republish to a dead sheet — stop checking it. Owner
--   extended this: no sheets for NEW providers going forward; EMS / WYK /
--   Courses Direct keep theirs until they move onto the portal.
--
--   This migration: (1) NULLs riverside-training's sheet_webhook_url so the
--   cron skips them, and (2) marks the moot Riverside sheet_drift_detected
--   notices resolved so they clear the failure queue.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: data fix on two config/log surfaces — one provider config
--      column + the moot Riverside drift-notice rows. No schema change.
--   2. Readers affected: sheet-drift-reconcile-daily (will now skip Riverside);
--      the /admin/errors drift surface (Riverside rows clear). No reader breaks.
--   3. Writers affected: none. Riverside leads still route + bill via the
--      portal/DB exactly as now; only the Google-sheet mirror + its drift check
--      are retired. sheet-edit-mirror / republish-provider-sheet simply have no
--      Riverside hook to act on.
--   4. schema_version: unchanged.
--   5. Data migration: the two statements below ARE the fix. Idempotent
--      (re-running NULLs an already-NULL value and resolves already-resolved
--      rows to no effect).
--   6. Role/policy: none.
--   7. Rollback: re-set sheet_webhook_url from a DB backup if Riverside ever
--      adopts a sheet again (the URL is deliberately not committed to git).
--   8. Sign-off: owner (this session, 2026-06-14).
--
-- Follow-up (NOT in this migration): the new-provider onboarding flow
--   (.claude/skills/new-apprenticeship-provider, provider-onboarding-playbook)
--   should stop setting sheet_webhook_url for new providers — portal-only by
--   default. Flagged in docs/changelog.md.
--
-- Related:
--   platform/supabase/functions/sheet-drift-reconcile-daily/index.ts (the cron)
--   Work Hub task c5268aab (Mira's reframe), e2b2615f (dead_letter governance)

-- UP
UPDATE crm.providers
   SET sheet_webhook_url = NULL
 WHERE provider_id = 'riverside-training';

UPDATE leads.dead_letter
   SET replayed_at = now()
 WHERE source = 'sheet_drift_detected'
   AND replayed_at IS NULL
   AND error_context ILIKE '%Riverside%';

-- DOWN
-- Restore sheet_webhook_url for riverside-training from a DB backup (the URL is
-- not stored here). The resolved dead_letter rows stay resolved.
