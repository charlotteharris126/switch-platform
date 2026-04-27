-- Migration 0019 — Supabase Vault helper for shared secrets + cron rewires
-- Date: 2026-04-25 (incident follow-up)
-- Author: Claude (platform Session 9 hotfix) with owner sign-off
-- Reason: Today's incident exposed that AUDIT_SHARED_SECRET was stored in two
--         drift-prone places — Edge Function env (read by reconcile + audit
--         functions) and the pg_cron command text (sent as x-audit-key
--         header). The cron's command text contained the literal placeholder
--         '<REPLACE_WITH_AUDIT_SHARED_SECRET>' instead of the real value, so
--         the hourly auto-reconcile has been silently failing 401 ever since.
--         The webhook covered the gap until today's webhook outage exposed
--         the silent cron failure.
--
--         Fix: make Supabase Vault the single source of truth for
--         AUDIT_SHARED_SECRET. The Edge Functions and the pg_cron jobs both
--         read from Vault via a single SECURITY DEFINER helper. Future
--         rotations are one-line vault.update_secret() calls — both surfaces
--         pick up the new value automatically.
--
--         This migration handles the structural pieces:
--           - public.get_shared_secret(name) helper (SECURITY DEFINER, locked
--             search_path, narrow allowlist of names it will return)
--           - GRANT EXECUTE to functions_writer and postgres roles
--           - Update cron jobids 4 (netlify-leads-reconcile) and 5
--             (netlify-forms-audit) to call the helper for the auth header
--
--         The actual secret value is inserted into Vault via a one-off
--         supabase db query (NOT committed to this iCloud-synced file per
--         .claude/rules/data-infrastructure.md §5 — secrets never in
--         iCloud-synced files in plaintext).
--
--         The Edge Functions netlify-leads-reconcile and netlify-forms-audit
--         are updated separately to read from Vault via the same helper, then
--         AUDIT_SHARED_SECRET is removed from Edge Function Secrets so Vault
--         is the only place it exists.
--
-- Related: platform/docs/changelog.md (today's incident),
--          platform/docs/data-architecture.md,
--          platform/docs/secrets-rotation.md (updated rotation runbook).

-- UP

-- =============================================================================
-- 1. Helper function: public.get_shared_secret(name)
-- =============================================================================
-- SECURITY DEFINER so callers don't need direct vault.decrypted_secrets access.
-- Hard-coded allowlist of secret names the helper will return — prevents a
-- compromised caller from probing for arbitrary Vault entries. Locked
-- search_path to prevent search_path attacks against SECURITY DEFINER
-- functions.

CREATE OR REPLACE FUNCTION public.get_shared_secret(p_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, vault
AS $$
DECLARE
  v_secret TEXT;
BEGIN
  -- Allowlist: only these names can be retrieved via this helper. Adding a
  -- new shared secret is a deliberate migration that extends this list.
  IF p_name NOT IN ('AUDIT_SHARED_SECRET') THEN
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
$$;

COMMENT ON FUNCTION public.get_shared_secret(TEXT) IS
  'Returns the decrypted Vault secret for the given name. Allowlist-restricted: only secrets named in the function body can be retrieved. Used by pg_cron jobs and Edge Functions that need shared-secret access without broad vault.decrypted_secrets exposure. Added migration 0019.';

-- =============================================================================
-- 2. Grants
-- =============================================================================
-- functions_writer: used by Edge Functions writing to leads.* (they SET LOCAL
--                   ROLE functions_writer for INSERT). They also need to read
--                   AUDIT_SHARED_SECRET to validate incoming x-audit-key
--                   headers from cron-triggered calls.
-- postgres:         used implicitly by pg_cron jobs (jobs run as the user that
--                   created them — postgres in this project).

REVOKE ALL ON FUNCTION public.get_shared_secret(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_shared_secret(TEXT) TO functions_writer;
GRANT EXECUTE ON FUNCTION public.get_shared_secret(TEXT) TO postgres;

-- =============================================================================
-- 3. Rewire pg_cron jobs to read auth header from Vault
-- =============================================================================
-- jobid 4: netlify-leads-reconcile (every 30 min)
-- jobid 5: netlify-forms-audit (hourly on the hour)
--
-- The cron command text constructs the http_post body with the auth header
-- pulled fresh from Vault on every run. No more drift-prone placeholder.

-- Reconcile cron: rewire
SELECT cron.alter_job(
  job_id := 4,
  command := $cmd$
    SELECT net.http_post(
      url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-leads-reconcile',
      headers := jsonb_build_object(
        'x-audit-key', public.get_shared_secret('AUDIT_SHARED_SECRET'),
        'content-type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 10000
    );
  $cmd$
);

-- Forms-audit cron: rewire
SELECT cron.alter_job(
  job_id := 5,
  command := $cmd$
    SELECT net.http_post(
      url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-forms-audit',
      headers := jsonb_build_object(
        'x-audit-key', public.get_shared_secret('AUDIT_SHARED_SECRET'),
        'content-type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 10000
    );
  $cmd$
);

-- DOWN
-- -- Restore the previous (broken) cron commands
-- SELECT cron.alter_job(
--   job_id := 4,
--   command := $cmd$
--     SELECT net.http_post(
--       url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-leads-reconcile',
--       headers := jsonb_build_object(
--         'x-audit-key', '<REPLACE_WITH_AUDIT_SHARED_SECRET>',
--         'content-type', 'application/json'
--       ),
--       body := '{}'::jsonb,
--       timeout_milliseconds := 10000
--     );
--   $cmd$
-- );
-- SELECT cron.alter_job(
--   job_id := 5,
--   command := $cmd$
--     SELECT net.http_post(
--       url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-forms-audit',
--       headers := jsonb_build_object(
--         'x-audit-key', '<REPLACE_WITH_AUDIT_SHARED_SECRET>',
--         'content-type', 'application/json'
--       ),
--       body := '{}'::jsonb,
--       timeout_milliseconds := 10000
--     );
--   $cmd$
-- );
-- REVOKE EXECUTE ON FUNCTION public.get_shared_secret(TEXT) FROM functions_writer, postgres;
-- DROP FUNCTION IF EXISTS public.get_shared_secret(TEXT);
-- -- Vault secret left in place; remove via:
-- -- SELECT vault.delete_secret(id) FROM vault.secrets WHERE name = 'AUDIT_SHARED_SECRET';
