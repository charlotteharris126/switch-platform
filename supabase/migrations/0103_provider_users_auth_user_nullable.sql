-- Migration 0103 — Make crm.provider_users.auth_user_id nullable
-- Date:    2026-05-09
-- Author:  Claude (platform Session 37 / Sasha) on Charlotte's instruction
-- Reason:  Provider portal P2 design: Supabase auth.users row is NOT created
--          at invite time, only at /api/passkey/register-verify after the
--          passkey ceremony succeeds. This closes the "dormant auth identity
--          is hijackable via OTP/magic-link before passkey registration"
--          edge case (Supabase Auth defaults allow signInWithOtp against
--          any auth.users with an email). By gating auth.users creation on
--          successful passkey enrolment, there is no identity for an
--          attacker to grab during the window between invite-send and
--          legitimate registration.
--
--          0094 declared auth_user_id NOT NULL UNIQUE. UNIQUE we keep
--          (one Supabase user maps to at most one provider). NOT NULL we
--          relax: an `invited` row has auth_user_id NULL until the passkey
--          ceremony completes.
--
--          UNIQUE on a nullable column: Postgres treats NULL values as
--          distinct, so multiple invited rows with NULL auth_user_id are
--          allowed (that is what we want — different providers can have
--          pending invites at the same time).
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: ALTER COLUMN ... DROP NOT NULL on a column added in 0094
--      that has zero existing rows. Pure relaxation, additive in effect.
--   2. Readers: admin dashboard queries that join auth_user_id need to
--      handle NULL. None ship pre-portal; all new code adds the NULL handling.
--   3. Writers: provider-invite-link Edge Function inserts with NULL;
--      /api/passkey/register-verify UPDATEs to a real UUID after passkey
--      registration.
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role/policy: unchanged.
--   7. Rollback: ALTER COLUMN ... SET NOT NULL — only safe if no NULL rows
--      exist. Worth backfilling/cleaning before any rollback.
--   8. Sign-off: owner (this session, 2026-05-09).
-- Related: 0094 (provider_users base), 0102 (passkey schema), Clara
--          condition (a) on RLS proof.

-- UP

ALTER TABLE crm.provider_users
  ALTER COLUMN auth_user_id DROP NOT NULL;

COMMENT ON COLUMN crm.provider_users.auth_user_id IS
  'Supabase Auth user this provider user maps to. NULL during the invited window (no auth.users row created yet, by design — see migration 0103). Set to a real UUID at /api/passkey/register-verify after a passkey ceremony succeeds. UNIQUE constraint allows multiple NULL rows (Postgres NULL-distinct semantics).';

-- DOWN
-- ALTER TABLE crm.provider_users
--   ALTER COLUMN auth_user_id SET NOT NULL;
-- (Only safe when no NULL rows exist. Backfill or clean up first.)
