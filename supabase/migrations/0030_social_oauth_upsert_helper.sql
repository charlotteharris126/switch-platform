-- Migration 0030 — Social OAuth token upsert helper (Session G.2)
-- Date: 2026-04-27
-- Author: Claude (platform Session 12) with owner sign-off
-- Reason: The OAuth callback route in Session G.2 receives a raw access token
--         from LinkedIn (and optionally a refresh token). The token must be
--         encrypted at rest in vault.secrets, with only a UUID handle stored on
--         social.oauth_tokens. Doing this in the callback route would mean two
--         round-trips (vault.create_secret() then INSERT) and a window where
--         an inconsistent state is possible (encrypted but not linked, or
--         linked but not encrypted).
--
--         This helper does it in one transaction. Inputs: brand, channel,
--         provider, external_account_id, raw access_token, optional raw
--         refresh_token, expires_at, scopes, authorised_by. Output: the row
--         id of the social.oauth_tokens row.
--
--         Steps inside:
--         1. Verify caller is admin (admin.is_admin() — same gate as every
--            other write surface).
--         2. Validate enums match the table's CHECK constraints.
--         3. Look up any existing row for this (brand, channel) pair (used
--            for audit before-state).
--         4. vault.create_secret() for the access token.
--         5. vault.create_secret() for the refresh token if present.
--         6. UPSERT social.oauth_tokens with the metadata + secret_id refs.
--         7. audit.log_action() row written (admin surface).
--
--         Old vault secrets from a replaced row are NOT auto-deleted — they
--         remain in vault.secrets as an audit trail of token rotation. A
--         separate cleanup job can purge them after a retention window if
--         storage becomes a concern (Supabase Vault is cheap; not a near-term
--         issue).
--
-- Related: platform/supabase/migrations/0029_social_schema.sql (defines
--          social.oauth_tokens and the secret_id columns),
--          platform/supabase/migrations/0019_vault_helper_for_shared_secrets.sql
--          (Vault precedent — public.get_shared_secret),
--          platform/supabase/migrations/0014_admin_dashboard_read_access.sql
--          (admin.is_admin()),
--          platform/supabase/migrations/0020_audit_log_action_helper.sql
--          (audit.log_action),
--          platform/docs/admin-dashboard-scoping.md § Session G "OAuth
--          integration" (the routes that call this helper).

-- UP

CREATE OR REPLACE FUNCTION social.upsert_oauth_token(
  p_brand               TEXT,
  p_channel             TEXT,
  p_provider            TEXT,
  p_external_account_id TEXT,
  p_access_token        TEXT,
  p_refresh_token       TEXT DEFAULT NULL,
  p_expires_at          TIMESTAMPTZ DEFAULT NULL,
  p_scopes              TEXT[] DEFAULT NULL,
  p_authorised_by       UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, social, vault, audit, admin
AS $$
DECLARE
  v_existing            social.oauth_tokens%ROWTYPE;
  v_access_secret_id    UUID;
  v_refresh_secret_id   UUID;
  v_token_row_id        UUID;
  v_secret_name_access  TEXT;
  v_secret_name_refresh TEXT;
  v_authorised_by       UUID;
BEGIN
  -- Admin gate
  IF NOT admin.is_admin() THEN
    RAISE EXCEPTION 'Only admins can upsert OAuth tokens'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Source of truth for authorised_by: the request's authenticated user
  -- via auth.uid(). Caller-supplied p_authorised_by is accepted as a fallback
  -- only (e.g. for hypothetical automation calls without an auth context),
  -- but a real session JWT always wins.
  v_authorised_by := coalesce(auth.uid(), p_authorised_by);

  -- Enum validation (same set as the table CHECK constraints)
  IF p_brand NOT IN ('switchleads', 'switchable') THEN
    RAISE EXCEPTION 'Invalid brand %: must be switchleads or switchable', p_brand
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_channel NOT IN ('linkedin_personal', 'linkedin_company', 'meta_facebook', 'meta_instagram', 'tiktok') THEN
    RAISE EXCEPTION 'Invalid channel %: must be linkedin_personal, linkedin_company, meta_facebook, meta_instagram or tiktok', p_channel
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_provider NOT IN ('linkedin', 'meta', 'tiktok') THEN
    RAISE EXCEPTION 'Invalid provider %: must be linkedin, meta or tiktok', p_provider
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_access_token IS NULL OR length(trim(p_access_token)) = 0 THEN
    RAISE EXCEPTION 'access_token is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  -- Capture existing row for audit before-state
  SELECT * INTO v_existing
    FROM social.oauth_tokens
   WHERE brand = p_brand AND channel = p_channel
   LIMIT 1;

  -- Vault secret names — guaranteed unique via gen_random_uuid() suffix.
  -- Uniqueness on vault.secrets.name is enforced by Postgres; using a
  -- timestamp would collide if two re-authorisations happen within the same
  -- second. The UUID makes rotation race-free.
  v_secret_name_access  := format('social.oauth.%s.%s.access.%s',  p_brand, p_channel, gen_random_uuid());
  v_secret_name_refresh := format('social.oauth.%s.%s.refresh.%s', p_brand, p_channel, gen_random_uuid());

  -- Encrypt + store access token
  v_access_secret_id := vault.create_secret(
    p_access_token,
    v_secret_name_access,
    format('Access token for (%s, %s) — issued %s', p_brand, p_channel, now())
  );

  -- Encrypt + store refresh token if provided
  IF p_refresh_token IS NOT NULL AND length(trim(p_refresh_token)) > 0 THEN
    v_refresh_secret_id := vault.create_secret(
      p_refresh_token,
      v_secret_name_refresh,
      format('Refresh token for (%s, %s) — issued %s', p_brand, p_channel, now())
    );
  END IF;

  -- Upsert metadata row
  INSERT INTO social.oauth_tokens (
    brand, channel, provider, external_account_id,
    access_token_secret_id, refresh_token_secret_id,
    expires_at, scopes, last_refreshed_at,
    authorised_by, authorised_at
  ) VALUES (
    p_brand, p_channel, p_provider, p_external_account_id,
    v_access_secret_id, v_refresh_secret_id,
    p_expires_at, p_scopes, now(),
    v_authorised_by, now()
  )
  ON CONFLICT (brand, channel) DO UPDATE SET
    provider                = EXCLUDED.provider,
    external_account_id     = EXCLUDED.external_account_id,
    access_token_secret_id  = EXCLUDED.access_token_secret_id,
    refresh_token_secret_id = EXCLUDED.refresh_token_secret_id,
    expires_at              = EXCLUDED.expires_at,
    scopes                  = EXCLUDED.scopes,
    last_refreshed_at       = now(),
    authorised_by           = EXCLUDED.authorised_by,
    authorised_at           = now()
  RETURNING id INTO v_token_row_id;

  -- Audit
  PERFORM audit.log_action(
    p_action       := 'social.upsert_oauth_token',
    p_target_table := 'social.oauth_tokens',
    p_target_id    := v_token_row_id::text,
    p_before       := CASE
      WHEN v_existing.id IS NOT NULL THEN jsonb_build_object(
        'brand',               v_existing.brand,
        'channel',             v_existing.channel,
        'provider',            v_existing.provider,
        'external_account_id', v_existing.external_account_id,
        'expires_at',          v_existing.expires_at,
        'scopes',              v_existing.scopes,
        'old_access_secret',   v_existing.access_token_secret_id,
        'old_refresh_secret',  v_existing.refresh_token_secret_id
      )
      ELSE NULL
    END,
    p_after        := jsonb_build_object(
      'brand',               p_brand,
      'channel',             p_channel,
      'provider',            p_provider,
      'external_account_id', p_external_account_id,
      'expires_at',          p_expires_at,
      'scopes',              p_scopes,
      'access_secret',       v_access_secret_id,
      'refresh_secret',      v_refresh_secret_id
    ),
    p_context      := jsonb_build_object(
      'is_rotation', v_existing.id IS NOT NULL
    ),
    p_surface      := 'admin'
  );

  RETURN v_token_row_id;
END;
$$;

COMMENT ON FUNCTION social.upsert_oauth_token(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT[], UUID) IS
  'Atomically encrypts an OAuth token via Supabase Vault and upserts the metadata row in social.oauth_tokens. Admin-gated. The only sanctioned write path for OAuth tokens. Old vault secrets from a replaced row are kept (not auto-deleted) as audit trail. Added migration 0030.';

REVOKE ALL ON FUNCTION social.upsert_oauth_token(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT[], UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION social.upsert_oauth_token(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT[], UUID) TO authenticated;

-- DOWN
-- REVOKE EXECUTE ON FUNCTION social.upsert_oauth_token(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT[], UUID) FROM authenticated;
-- DROP FUNCTION IF EXISTS social.upsert_oauth_token(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT[], UUID);
-- -- Vault entries created by this function during its lifetime remain in vault.secrets;
-- -- clean up via:
-- -- DELETE FROM vault.secrets WHERE name LIKE 'social.oauth.%';
