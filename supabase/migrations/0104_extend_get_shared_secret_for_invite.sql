-- Migration 0104 — Extend public.get_shared_secret() allowlist for PROVIDER_INVITE_SECRET
-- Date:    2026-05-09
-- Author:  Claude (platform Session 37 / Sasha) on Charlotte's instruction
-- Reason:  Provider portal MVP P2 introduced PROVIDER_INVITE_SECRET as the
--          HMAC signing key for enrolment-only invite tokens. Initially
--          stored in two places (Supabase Edge Function secrets + Netlify
--          env), which immediately reintroduced the two-store drift class
--          documented in secrets-rotation.md (Session 9 incident). Drift
--          surfaced in this same session: Edge Function signed with one
--          value, Next.js verified with another, every invite click
--          returned token_bad_signature.
--
--          Same fix as 0019 applied to AUDIT_SHARED_SECRET: move to the
--          database vault (single source of truth) and read via the
--          allowlisted public.get_shared_secret() SECURITY DEFINER helper.
--          Both Edge Function and Next.js read the same Vault row at call
--          time. No env stores, no copy/paste, no rotation lockstep.
--
--          This migration extends the allowlist to include
--          PROVIDER_INVITE_SECRET. The actual vault secret row is created
--          by the owner running, separately from this migration:
--
--            SELECT vault.create_secret('<openssl rand -hex 32 output>', 'PROVIDER_INVITE_SECRET');
--
--          Owner runs this once via the Supabase SQL editor (it is NOT
--          checked in as part of this migration so the secret value never
--          touches git or iCloud).
--
--          After the secret is in vault, the owner deletes the duplicate
--          values from:
--            - Supabase Edge Function secrets (Project Settings → Edge
--              Functions → Manage secrets)
--            - Netlify environment variables
--
--          Cleanup completes the single-source-of-truth migration.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: replace public.get_shared_secret() function body with an
--      extended allowlist {AUDIT_SHARED_SECRET, PROVIDER_INVITE_SECRET}.
--   2. Readers: provider-invite-link Edge Function (after refactor in this
--      session); /api/passkey/register-options + register-verify routes in
--      Next.js (after refactor in this session). Existing AUDIT_SHARED_SECRET
--      callers are unaffected — same function, same return shape, broader
--      allowlist.
--   3. Writers: owner via vault.create_secret() / vault.update_secret().
--   4. Schema version: not affected.
--   5. Data migration: none. Owner-driven vault row insert is separate.
--   6. Role/policy: SECURITY DEFINER, search_path locked to vault. Unchanged.
--   7. Rollback: revert the function body to the single-allowlist form.
--   8. Sign-off: owner (this session, 2026-05-09).
-- Related: 0019 (initial pattern for AUDIT_SHARED_SECRET), secrets-rotation.md.

-- UP

CREATE OR REPLACE FUNCTION public.get_shared_secret(p_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'vault'
AS $function$
DECLARE
  v_secret TEXT;
BEGIN
  -- Allowlist: only these names can be retrieved via this helper. Adding a
  -- new shared secret is a deliberate migration that extends this list.
  IF p_name NOT IN ('AUDIT_SHARED_SECRET', 'PROVIDER_INVITE_SECRET') THEN
    RAISE EXCEPTION 'Secret % is not in the allowlist. Add it to public.get_shared_secret() if needed.', p_name
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT decrypted_secret
    INTO v_secret
    FROM vault.decrypted_secrets
   WHERE name = p_name
   LIMIT 1;

  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'Secret % not found in vault. Run vault.create_secret(...) first.', p_name
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN v_secret;
END;
$function$;

-- DOWN
-- CREATE OR REPLACE FUNCTION public.get_shared_secret(p_name TEXT)
-- RETURNS TEXT
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path TO 'pg_catalog', 'vault'
-- AS $function$
-- DECLARE v_secret TEXT;
-- BEGIN
--   IF p_name NOT IN ('AUDIT_SHARED_SECRET') THEN
--     RAISE EXCEPTION 'Secret % is not in the allowlist.', p_name USING ERRCODE = 'insufficient_privilege';
--   END IF;
--   SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = p_name LIMIT 1;
--   IF v_secret IS NULL THEN RAISE EXCEPTION 'Secret % not found in vault.', p_name; END IF;
--   RETURN v_secret;
-- END;
-- $function$;
