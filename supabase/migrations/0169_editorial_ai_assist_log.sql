-- Migration 0169 — editorial.ai_assist_log + ANTHROPIC_API_KEY allowlist
-- Date: 2026-05-25
-- Author: Claude (Sasha, platform session) with owner sign-off
-- Reason:
--   Powers the AI-assist editor surface (CMS Phase 2). The blog-ai-assist
--   Edge Function calls Claude API for outline / headlines / meta-description
--   / excerpt / tags suggestions; each call writes a row here so Charlotte
--   can see cost trends and per-surface usage. Cost estimate is computed
--   from Claude pricing at call time and stored as USD with 6 dp.
--
-- Related:
--   platform/supabase/functions/blog-ai-assist/index.ts (writer)
--   platform/app/app/admin/blog/post-form.tsx (caller via aiAssistAction)
--   platform/supabase/migrations/0019_vault_helper_for_shared_secrets.sql (allowlist precedent)
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new table editorial.ai_assist_log + extend get_shared_secret
--      allowlist with ANTHROPIC_API_KEY.
--   2. Readers / writers: functions_writer writes (the EF). readonly_analytics
--      reads (so Charlotte's dashboards / Mira's strategy queries can roll up
--      cost). admin (CMS) reads via RPC for the in-editor usage summary.
--   3. Schema_version: no contract bumped.
--   4. Data migration: none. Empty on apply.
--   5. New role / policy: none.
--   6. Rollback: DROP TABLE + revert allowlist.
--   7. Sign-off: owner 2026-05-25.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. ai_assist_log — one row per Claude API call from the editor
-- ---------------------------------------------------------------------------

CREATE TABLE editorial.ai_assist_log (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Which suggest surface was invoked. One of outline / headlines /
  -- meta_description / excerpt / tags. Free-text so future surfaces don't
  -- need a migration; admin UI groups by this.
  kind            TEXT NOT NULL,
  -- Post the call was for. NULL for create-mode where the post hasn't been
  -- persisted yet (suggestions fire before first save).
  post_id         BIGINT REFERENCES editorial.posts(id) ON DELETE SET NULL,
  post_slug       TEXT,                 -- snapshot at call time, survives post delete
  -- Claude model used + token-level usage.
  model           TEXT NOT NULL,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  -- Cost estimate in USD computed at call time from the model's per-token
  -- pricing constants embedded in the EF. Stored so the admin doesn't need
  -- to re-derive when pricing changes upstream.
  cost_usd        NUMERIC(10, 6) NOT NULL DEFAULT 0,
  -- Round-trip latency (EF perspective) for performance tracking.
  latency_ms      INTEGER,
  -- Success / failure. Failures still log so cost dashboards see the API
  -- charge AND Charlotte sees what surfaces are flaky.
  ok              BOOLEAN NOT NULL,
  error_message   TEXT
);

CREATE INDEX ai_assist_log_created_at_idx ON editorial.ai_assist_log (created_at DESC);
CREATE INDEX ai_assist_log_kind_created_idx ON editorial.ai_assist_log (kind, created_at DESC);

COMMENT ON TABLE editorial.ai_assist_log IS
  'Per-call audit + cost log for blog-ai-assist Edge Function. One row per Claude API call from the /admin/blog editor. Use for cost trending, surface-usage analytics, and failure debugging.';

GRANT USAGE ON SCHEMA editorial TO functions_writer;
GRANT INSERT ON editorial.ai_assist_log TO functions_writer;
GRANT USAGE, SELECT ON SEQUENCE editorial.ai_assist_log_id_seq TO functions_writer;
GRANT SELECT ON editorial.ai_assist_log TO readonly_analytics, authenticated;

ALTER TABLE editorial.ai_assist_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "functions_writer insert ai_assist_log"
  ON editorial.ai_assist_log FOR INSERT TO functions_writer WITH CHECK (true);

CREATE POLICY "readonly_analytics select ai_assist_log"
  ON editorial.ai_assist_log FOR SELECT TO readonly_analytics USING (true);

CREATE POLICY "authenticated admin select ai_assist_log"
  ON editorial.ai_assist_log FOR SELECT TO authenticated
  USING (admin.is_admin());

-- ---------------------------------------------------------------------------
-- 2. Extend get_shared_secret allowlist with ANTHROPIC_API_KEY
--    Full replace per the pattern in 0104 / 0167.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_shared_secret(p_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'vault'
AS $function$
DECLARE
  v_secret TEXT;
BEGIN
  IF p_name NOT IN (
    'AUDIT_SHARED_SECRET',
    'PROVIDER_INVITE_SECRET',
    'NETLIFY_SWITCHABLE_BUILD_HOOK',
    'ANTHROPIC_API_KEY'
  ) THEN
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

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP TABLE IF EXISTS editorial.ai_assist_log;
-- -- Revert get_shared_secret to 0167 allowlist (no ANTHROPIC_API_KEY).
-- CREATE OR REPLACE FUNCTION public.get_shared_secret(p_name TEXT) ...;
-- COMMIT;
