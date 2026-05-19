-- Migration 0153 — drop count_client_nonce_pending RPC
-- Date: 2026-05-19 (Session 54)
-- Author: Claude (Sasha session) with owner sign-off
-- Reason: The 025 client_nonce backfill panel was deleted in S52 (after the
--         BEFORE INSERT trigger from migration 0152 closed the upstream leak
--         that made the panel necessary). The RPC was the auto-hide signal
--         for the panel — no consumer reads it any more. Drop to clean up
--         the dead surface area.
--
-- Related:
--   - Migration 0113 (creates this function — the UP we're undoing)
--   - Migration 0152 (the BEFORE INSERT trigger that obsoleted the backfill)
--   - This session deletes the matching backfill-client-nonce Edge Function
--     source from the repo. The function stays deployed on Supabase until
--     manually removed via `supabase functions delete backfill-client-nonce`.
--   - platform/docs/changelog.md — Session 54 entry

-- UP
DROP FUNCTION IF EXISTS public.count_client_nonce_pending();

-- DOWN
-- See migration 0113 for the original definition. To restore, re-run 0113.
