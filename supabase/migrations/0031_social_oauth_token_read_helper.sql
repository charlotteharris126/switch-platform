-- Migration 0031 — Social OAuth token-read helper (Session G.3)
-- Date: 2026-04-27
-- Author: Claude (platform Session 12) with owner sign-off
-- Reason: The social-publish Edge Function needs to read the decrypted
--         OAuth access_token to call LinkedIn / Meta / TikTok APIs. Direct
--         access to vault.decrypted_secrets is REVOKE'd from authenticated
--         and anon (migration 0029); only postgres / service_role can read
--         it. Edge Functions run as service_role, so they CAN read vault
--         directly — but doing so spreads vault access across N callers
--         and creates a maintenance hazard if a future Edge Function is
--         careless.
--
--         This helper is the ONE sanctioned path to read OAuth tokens:
--         it accepts a (brand, channel) pair, looks up the oauth_tokens
--         row, validates that this (brand, channel) is allowlisted for
--         token reads, fetches the access_token via vault.decrypted_secrets,
--         and returns the plaintext to the caller. Audit row written for
--         every successful read.
--
--         Mirrors the pattern from migration 0019 (`public.get_shared_secret`)
--         which does the same job for AUDIT_SHARED_SECRET — single helper,
--         allowlist, audit.
--
--         Granted to service_role only. Authenticated users (admin UI) do
--         NOT need to call this — they read social.oauth_tokens metadata
--         (brand, channel, expires_at, etc.) but never the raw token.
--         Edge Functions run as service_role and can call this helper.
--
-- Related: platform/supabase/migrations/0029_social_schema.sql (creates
--          social.oauth_tokens with secret_id columns),
--          platform/supabase/migrations/0030_social_oauth_upsert_helper.sql
--          (the write-side companion: encrypt + upsert),
--          platform/supabase/migrations/0019_vault_helper_for_shared_secrets.sql
--          (precedent pattern).

-- UP

CREATE OR REPLACE FUNCTION social.get_oauth_access_token(
  p_brand   TEXT,
  p_channel TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, social, vault, audit
AS $$
DECLARE
  v_secret_id          UUID;
  v_external_account   TEXT;
  v_decrypted          TEXT;
BEGIN
  -- Allowlist: only specific (brand, channel) pairs can have their tokens
  -- read. Today this matches the channels in the social.* enum. The
  -- allowlist exists so a future bug that lets a non-service_role caller
  -- pass arbitrary (brand, channel) values still can't probe vault.
  IF p_brand NOT IN ('switchleads', 'switchable') THEN
    RAISE EXCEPTION 'Invalid brand %: must be switchleads or switchable', p_brand
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_channel NOT IN ('linkedin_personal', 'linkedin_company', 'meta_facebook', 'meta_instagram', 'tiktok') THEN
    RAISE EXCEPTION 'Invalid channel %: must be linkedin_personal, linkedin_company, meta_facebook, meta_instagram or tiktok', p_channel
      USING ERRCODE = 'check_violation';
  END IF;

  -- Look up the secret_id for this (brand, channel) pair
  SELECT access_token_secret_id, external_account_id
    INTO v_secret_id, v_external_account
    FROM social.oauth_tokens
   WHERE brand = p_brand AND channel = p_channel
   LIMIT 1;

  IF v_secret_id IS NULL THEN
    RAISE EXCEPTION 'No OAuth token configured for (%, %). Run the OAuth flow via /social/settings first.', p_brand, p_channel
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Read the decrypted secret from vault
  SELECT decrypted_secret
    INTO v_decrypted
    FROM vault.decrypted_secrets
   WHERE id = v_secret_id
   LIMIT 1;

  IF v_decrypted IS NULL THEN
    RAISE EXCEPTION 'Vault secret % not found. social.oauth_tokens.access_token_secret_id may be stale.', v_secret_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Audit. We log a system-surface row each time a token is read so any
  -- runaway publishing or token-extraction attempt leaves a trail. The raw
  -- token never appears in the audit row — only the (brand, channel) and
  -- the secret_id (which is meaningless without vault access).
  PERFORM audit.log_system_action(
    p_actor        := 'system:social-publish',
    p_action       := 'social.read_oauth_token',
    p_target_table := 'social.oauth_tokens',
    p_target_id    := v_secret_id::text,
    p_before       := NULL,
    p_after        := NULL,
    p_context      := jsonb_build_object(
      'brand',                p_brand,
      'channel',              p_channel,
      'external_account_id',  v_external_account
    )
  );

  RETURN v_decrypted;
END;
$$;

COMMENT ON FUNCTION social.get_oauth_access_token(TEXT, TEXT) IS
  'Returns the decrypted OAuth access_token for a given (brand, channel). Allowlist-restricted to known brand/channel enum values. Granted to service_role only — Edge Functions read tokens through this helper, never via direct vault access. Each call writes a system audit row. Added migration 0031.';

REVOKE ALL ON FUNCTION social.get_oauth_access_token(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION social.get_oauth_access_token(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION social.get_oauth_access_token(TEXT, TEXT) TO postgres;

-- DOWN
-- REVOKE EXECUTE ON FUNCTION social.get_oauth_access_token(TEXT, TEXT) FROM service_role, postgres;
-- DROP FUNCTION IF EXISTS social.get_oauth_access_token(TEXT, TEXT);
