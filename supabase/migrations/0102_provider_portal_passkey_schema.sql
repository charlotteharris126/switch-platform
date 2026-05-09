-- Migration 0102 — Provider portal: passkey schema + invite token state
-- Date:    2026-05-09
-- Author:  Claude (platform Session 37 / Sasha) on Charlotte's instruction
-- Reason:  Auth model relocked to passkey-only on 2026-05-09 (was magic-link)
--          per Charlotte's UK GDPR Article 32 concern with email-borne auth
--          tokens. Clara approved the new model same session
--          (accounts-legal/changelog.md). Provider authenticates with a
--          WebAuthn passkey; admin issues a one-time enrolment-only invite
--          link that dies on first passkey registration. Recovery via admin
--          re-issue over phone-confirmed channel. No auth token ever sits
--          at rest in an email inbox.
--
--          Supabase Auth does not support WebAuthn / passkeys natively
--          (verified 2026-05-09: their MFA surface is TOTP + SMS only). We
--          implement WebAuthn ourselves using @simplewebauthn/server +
--          /browser, store credentials in our own table, and mint a Supabase
--          Auth session after we verify the passkey ceremony. This keeps the
--          stack self-contained, no new sub-processor.
--
--          What this migration adds:
--          1. `invited` status value on crm.provider_users (admin row exists
--             but provider hasn't enrolled a passkey yet)
--          2. Invite-token state on crm.provider_users:
--               - current_invite_token_hash (sha256 of the HMAC token)
--               - current_invite_expires_at (15-min default)
--               - current_invite_issued_by (admin auth user)
--             Single invite per user at a time. Issuing a new invite
--             overwrites the previous; verifying consumes the row's hash
--             (sets it to NULL).
--          3. enrolled_at timestamp — when the user first registered a
--             passkey. Used by the auth gate (auth.uid() must map to a
--             provider_users row with enrolled_at IS NOT NULL).
--          4. New table crm.provider_passkeys — one row per registered
--             passkey credential. Stores the public key (BYTEA), credential
--             id, signature counter (replay protection), and transport hints.
--             RLS: admin all, functions_writer all, readonly_analytics read.
--             Per-provider RLS for the provider_user role ships in 0103
--             alongside the rest of the portal RLS extension.
--
--          WebAuthn challenges are NOT stored in the DB. They live in
--          httpOnly signed cookies for the ~60s between options-call and
--          verify-call. Pattern: SimpleWebAuthn-recommended. Avoids a
--          churning ephemeral table and a cleanup cron.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: 1 table (crm.provider_passkeys), 4 new columns on
--      crm.provider_users, 1 CHECK extension. All additive — existing rows
--      unaffected, existing queries unaffected. New `invited` status applies
--      only to rows created by the new provider-invite-link Edge Function.
--   2. Readers: admin dashboard (will read from provider_passkeys to show
--      "Andy's iPhone, last used 2 days ago"); auth middleware (checks
--      provider_users.enrolled_at + provider_passkeys.disabled_at IS NULL).
--   3. Writers: provider-invite-link Edge Function (writes invite-token
--      columns); /api/passkey/register-verify (writes provider_passkeys row,
--      sets enrolled_at, clears invite-token columns); /api/passkey/login-verify
--      (updates last_used_at + counter).
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role/policy: 3-role pattern (admin, functions_writer, readonly_analytics).
--      Provider-side per-row policies on provider_passkeys ship in 0103.
--   7. Rollback: DOWN drops the table + columns + revoked CHECK extension.
--   8. Sign-off: owner (this session, 2026-05-09).
-- Related: provider-portal-mvp-scoping.md (passkey design + Clara approval),
--          accounts-legal/docs/current-handoff.md item 2 (Clara's three
--          gating conditions for real-provider cutover),
--          migration 0094 (crm.provider_users base table),
--          migration 0096 (RLS policies — provider_passkeys policies join
--          this set in 0103).

BEGIN;

-- =============================================================================
-- 1. Extend crm.provider_users.status to allow 'invited'
-- =============================================================================

ALTER TABLE crm.provider_users
  DROP CONSTRAINT IF EXISTS provider_users_status_check;

ALTER TABLE crm.provider_users
  ADD CONSTRAINT provider_users_status_check CHECK (status IN (
    'invited',    -- admin row created, awaiting passkey enrolment
    'active',     -- passkey enrolled, can log in
    'suspended',  -- temporarily blocked (kept for audit)
    'revoked'     -- permanently blocked (kept for audit + GDPR)
  ));

COMMENT ON COLUMN crm.provider_users.status IS
  'invited = admin row created, awaiting passkey enrolment (no auth.users yet either, created at verify-time). active = passkey enrolled, can log in. suspended = temporarily blocked. revoked = permanently blocked. Soft-disable rather than DELETE so the audit chain survives. Updated migration 0102.';

-- Existing rows with status='active' but no passkey enrolled would be
-- mid-state inconsistencies. None exist today (provider_users is empty
-- pre-portal). Sanity check: any row currently 'active' must have an
-- enrolled passkey post-migration. Validated by the auth middleware.

-- =============================================================================
-- 2. Invite-token state + enrolled_at on crm.provider_users
-- =============================================================================

ALTER TABLE crm.provider_users
  ADD COLUMN current_invite_token_hash  TEXT,
  ADD COLUMN current_invite_expires_at  TIMESTAMPTZ,
  ADD COLUMN current_invite_issued_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN enrolled_at                TIMESTAMPTZ;

COMMENT ON COLUMN crm.provider_users.current_invite_token_hash IS
  'sha256 of the active enrolment-only invite token. NULL means no live invite. Cleared (set to NULL) when the token is consumed at /api/passkey/register-verify. Single live invite per user — re-issuing overwrites. Token itself is HMAC-signed and never stored; only its sha256 is stored for single-use enforcement. Added migration 0102.';

COMMENT ON COLUMN crm.provider_users.current_invite_expires_at IS
  'When the active invite token expires. 15 minutes from issue by default. Verify endpoint rejects after this. Added migration 0102.';

COMMENT ON COLUMN crm.provider_users.current_invite_issued_by IS
  'Admin auth.users row that issued the invite. Audit trail. Added migration 0102.';

COMMENT ON COLUMN crm.provider_users.enrolled_at IS
  'Timestamp the provider user first completed passkey registration. NULL means status=invited (no passkey yet). Auth middleware requires NOT NULL. Added migration 0102.';

-- =============================================================================
-- 3. New table crm.provider_passkeys
-- =============================================================================

CREATE TABLE crm.provider_passkeys (
  id                BIGSERIAL PRIMARY KEY,
  provider_user_id  BIGINT NOT NULL REFERENCES crm.provider_users(id) ON DELETE CASCADE,
  credential_id     TEXT NOT NULL UNIQUE,
  public_key        BYTEA NOT NULL,
  counter           BIGINT NOT NULL DEFAULT 0,
  transports        TEXT[],
  device_type       TEXT CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up         BOOLEAN NOT NULL DEFAULT false,
  nickname          TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ,
  disabled_at       TIMESTAMPTZ
);

COMMENT ON TABLE crm.provider_passkeys IS
  'WebAuthn passkey credentials registered against provider_users. credential_id is the base64url-encoded credential identifier returned by the authenticator; public_key is the COSE-encoded public key bytes; counter is the WebAuthn signature counter for replay-attack detection (each authenticate must present a counter strictly greater than the stored value, except for known multi-device cases). disabled_at != NULL = passkey soft-disabled by admin (lost device, etc.); not deleted to preserve audit chain. Added migration 0102.';

COMMENT ON COLUMN crm.provider_passkeys.counter IS
  'WebAuthn signature counter. Each authenticate ceremony returns a counter value; if it is not strictly greater than the stored counter (and the authenticator is single-device), the assertion is rejected as a replay. Multi-device passkeys (synced via iCloud Keychain etc.) may legitimately reset counter to 0; tolerate this when device_type=multiDevice.';

COMMENT ON COLUMN crm.provider_passkeys.disabled_at IS
  'Admin soft-disable timestamp. Auth middleware ignores rows where disabled_at IS NOT NULL. Re-enabling requires admin action; lost-device path is to disable + re-issue invite link.';

CREATE INDEX provider_passkeys_provider_user_idx
  ON crm.provider_passkeys (provider_user_id)
  WHERE disabled_at IS NULL;

CREATE INDEX provider_passkeys_credential_lookup_idx
  ON crm.provider_passkeys (credential_id)
  WHERE disabled_at IS NULL;

-- =============================================================================
-- 4. RLS + role policies on crm.provider_passkeys
-- =============================================================================

ALTER TABLE crm.provider_passkeys ENABLE ROW LEVEL SECURITY;

-- Admin (authenticated + admin.is_admin gate): full access for management UI
GRANT SELECT, INSERT, UPDATE, DELETE ON crm.provider_passkeys TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE crm.provider_passkeys_id_seq TO authenticated;

CREATE POLICY admin_all_provider_passkeys
  ON crm.provider_passkeys
  FOR ALL TO authenticated
  USING (admin.is_admin())
  WITH CHECK (admin.is_admin());

-- functions_writer: Edge Functions need INSERT (registration), SELECT
-- (login lookup by credential_id), UPDATE (counter + last_used_at on each
-- successful authenticate, disabled_at on admin disable).
GRANT SELECT, INSERT, UPDATE ON crm.provider_passkeys TO functions_writer;
GRANT USAGE, SELECT ON SEQUENCE crm.provider_passkeys_id_seq TO functions_writer;

CREATE POLICY functions_all_provider_passkeys
  ON crm.provider_passkeys
  FOR ALL TO functions_writer
  USING (true)
  WITH CHECK (true);

-- readonly_analytics: read-only for admin dashboard, Mira/Sasha via MCP.
GRANT SELECT ON crm.provider_passkeys TO readonly_analytics;

CREATE POLICY analytics_read_provider_passkeys
  ON crm.provider_passkeys
  FOR SELECT TO readonly_analytics
  USING (true);

-- Per-provider self-read for the provider_user role ships in migration 0103
-- alongside the rest of the portal RLS extension. Provider should be able to
-- list/rename/disable their own passkeys but not see other providers'.

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS analytics_read_provider_passkeys ON crm.provider_passkeys;
-- DROP POLICY IF EXISTS functions_all_provider_passkeys ON crm.provider_passkeys;
-- DROP POLICY IF EXISTS admin_all_provider_passkeys ON crm.provider_passkeys;
-- REVOKE ALL ON crm.provider_passkeys FROM readonly_analytics;
-- REVOKE ALL ON crm.provider_passkeys FROM functions_writer;
-- REVOKE ALL ON SEQUENCE crm.provider_passkeys_id_seq FROM functions_writer;
-- REVOKE ALL ON crm.provider_passkeys FROM authenticated;
-- REVOKE ALL ON SEQUENCE crm.provider_passkeys_id_seq FROM authenticated;
-- DROP INDEX IF EXISTS crm.provider_passkeys_credential_lookup_idx;
-- DROP INDEX IF EXISTS crm.provider_passkeys_provider_user_idx;
-- DROP TABLE IF EXISTS crm.provider_passkeys;
--
-- ALTER TABLE crm.provider_users
--   DROP COLUMN enrolled_at,
--   DROP COLUMN current_invite_issued_by,
--   DROP COLUMN current_invite_expires_at,
--   DROP COLUMN current_invite_token_hash;
--
-- ALTER TABLE crm.provider_users DROP CONSTRAINT IF EXISTS provider_users_status_check;
-- ALTER TABLE crm.provider_users
--   ADD CONSTRAINT provider_users_status_check CHECK (status IN (
--     'active', 'suspended', 'revoked'
--   ));
-- COMMIT;
