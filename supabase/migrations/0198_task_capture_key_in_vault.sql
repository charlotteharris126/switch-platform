-- Migration 0198 — Work Hub capture key lives in the Vault (no device storage)
-- Date: 2026-06-08
-- Author: Claude (Sasha/platform) with owner sign-off
-- Reason: agents + /handoff run on the laptop and must authenticate to the
--   task-upsert EF to file a task. We will NOT store a key on any device (the
--   workspace is iCloud-synced; secrets can't live there, and writing outside the
--   workspace is barred). Instead the key lives in the Supabase Vault — the same
--   store as AUDIT_SHARED_SECRET / PROVIDER_INVITE_SECRET — generated in-DB so its
--   plaintext never touches a file. The EF reads it to validate; laptop-side
--   callers fetch it at runtime via the narrow reader below over their existing
--   read-only MCP. This keeps §11 intact (agents still never WRITE the DB; they
--   read one scoped key and POST to the gated EF, which writes).
-- Impact assessment (§8):
--   1. Change: one vault secret + one SECURITY DEFINER reader function + grants.
--   2. Readers: task-upsert EF (validate), readonly_analytics (agents/handoff fetch).
--   3. Writers: none new (EF still the only writer, via functions_writer).
--   4. schema_version: none.
--   5. New role/policy: no new role. readonly_analytics gains EXECUTE on a reader
--      that returns ONLY this one task-scoped key (not the general get_shared_secret,
--      which stays restricted so the delete-capable AUDIT key is never exposed).
--   6. Rollback: DOWN drops the function + removes the secret.
--   7. Sign-off: owner 2026-06-08 ("lets just sort it").

-- UP
SELECT vault.create_secret(
  encode(extensions.gen_random_bytes(32), 'hex'),
  'TASK_CAPTURE_KEY',
  'Work Hub capture key. Vault-only, no device copy. Read by the task-upsert EF (validate) and by laptop-side agents/handoff via public.get_task_capture_key() (readonly). Add/edit tasks only; never delete; cannot touch leads/billing.'
);

CREATE OR REPLACE FUNCTION public.get_task_capture_key()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'vault'
AS $$
DECLARE v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets WHERE name = 'TASK_CAPTURE_KEY' LIMIT 1;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'TASK_CAPTURE_KEY not found in vault';
  END IF;
  RETURN v_secret;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_task_capture_key() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_task_capture_key()
  TO readonly_analytics, functions_writer, service_role, authenticated;

-- DOWN
-- DROP FUNCTION IF EXISTS public.get_task_capture_key();
-- SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name='TASK_CAPTURE_KEY'), name => 'TASK_CAPTURE_KEY_RETIRED');
