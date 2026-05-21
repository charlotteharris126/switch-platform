-- Migration 0155 — Switch leads.partials uniqueness from (session_id) to (session_id, form_name)
-- Date: 2026-05-21
-- Author: Claude (Sasha, platform session) with owner sign-off
-- Reason:
--   netlify-partial-capture upserts on session_id alone (migration 0004 set the
--   column-level UNIQUE). When the same browser session crosses form contexts
--   (e.g. /funded/courses/<slug>/ mints session_id under form_name='switchable-funded',
--   then the visitor lands on /funded/thank-you/ where partial-tracker fires with
--   form_name='fastrack-funded-v1'), the second tracker hits the existing row and
--   merges its answers in — preserving the original form_name. Result: 0-ever rows
--   for fastrack-funded-v1 and switchable-waitlist-enrichment in 72h, even though
--   the data is landing (visible in the answers JSONB on the parent rows).
--   Diagnosed by Mable 2026-05-21; verified by Sasha against the source.
-- Related:
--   platform/supabase/migrations/0004_add_leads_partials.sql (original UNIQUE)
--   platform/supabase/functions/netlify-partial-capture/index.ts (ON CONFLICT clause; updated same session)
--   platform/docs/data-architecture.md (leads.partials section)
--   platform/docs/changelog.md (2026-05-21 entry)
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: drop column-level UNIQUE on leads.partials.session_id; add composite UNIQUE (session_id, form_name).
--   2. Readers: readonly_analytics (Metabase, agent MCPs, /admin/partials). Per-form-name filter starts
--      returning real activity for fastrack-funded-v1 and switchable-waitlist-enrichment. No existing
--      query breaks — session_id remains indexed via the composite (Postgres uses leftmost prefix).
--   3. Writers: netlify-partial-capture only. Same-session deploy switches ON CONFLICT clause.
--      _shared/ingest.ts is_complete flip is WHERE session_id = $1 (form_name-agnostic) — works
--      unchanged post-fix; flips whichever form contexts the session touched.
--   4. Schema_version: leads.partials carries schema_version='1.0' on each row. Structural-only
--      change, payload contract unchanged. No bump.
--   5. Data migration: none. Existing rows preserve uniqueness because session_id was previously
--      UNIQUE, so (session_id, form_name) is also unique on every existing row.
--   6. New role / policy: none.
--   7. Rollback: drop composite, restore column-level UNIQUE, revert EF ON CONFLICT clause.
--   8. Sign-off: owner 2026-05-21. No cross-brand impact.
--
-- Before running:
--   1. Verify Edge Function patch is staged in the same deploy (ON CONFLICT (session_id, form_name)).
--      The constraint switch and the EF must land together — otherwise the EF upsert fails with
--      "no unique constraint matching the ON CONFLICT specification".
--   2. Run as the postgres superuser.

-- UP

-- The original UNIQUE was created as a column constraint, so Postgres named it
-- automatically. Drop by constraint name resolved dynamically to keep this safe
-- across environments where the auto-generated name might differ.
DO $$
DECLARE
  conname TEXT;
  session_id_attnum SMALLINT;
BEGIN
  SELECT attnum INTO session_id_attnum
    FROM pg_attribute
   WHERE attrelid = 'leads.partials'::regclass
     AND attname = 'session_id';

  SELECT c.conname INTO conname
    FROM pg_constraint c
   WHERE c.conrelid = 'leads.partials'::regclass
     AND c.contype = 'u'
     AND c.conkey = ARRAY[session_id_attnum]::smallint[];

  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE leads.partials DROP CONSTRAINT %I', conname);
  END IF;
END
$$;

ALTER TABLE leads.partials
  ADD CONSTRAINT leads_partials_session_form_uniq UNIQUE (session_id, form_name);

COMMENT ON CONSTRAINT leads_partials_session_form_uniq ON leads.partials IS
  'Each (session_id, form_name) pair gets its own row. Allows a single browser session to track multiple form contexts (funded funnel + post-submit fastrack + waitlist enrichment) without merging answers across contexts. Bug fix vs original UNIQUE (session_id) in migration 0004 — see migration 0155 header and changelog 2026-05-21.';

-- VERIFICATION
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conrelid = 'leads.partials'::regclass
--      AND contype = 'u';
--   Expected: one row, leads_partials_session_form_uniq UNIQUE (session_id, form_name)
--
--   After EF redeploy, insert a row with the same session_id under a different form_name
--   and confirm two rows exist:
--     SELECT id, session_id, form_name FROM leads.partials WHERE session_id = '<test_uuid>';

-- DOWN
-- ALTER TABLE leads.partials DROP CONSTRAINT leads_partials_session_form_uniq;
-- ALTER TABLE leads.partials ADD CONSTRAINT leads_partials_session_id_key UNIQUE (session_id);
-- (And revert netlify-partial-capture ON CONFLICT clause to (session_id) alone.)
