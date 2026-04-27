-- Migration 0004 — Add leads.partials table for funnel drop-off tracking
-- Date: 2026-04-19
-- Author: Claude (Session — partial submissions build) with owner review and Mira architectural sign-off
-- Reason: Capture progressive form sessions (non-PII) so we can analyse where
--         learners drop off on the multi-step forms (switchable-self-funded,
--         switchable-funded) and which traffic / answer patterns correlate
--         with drop-off. Used to optimise the funnel and allocate ad spend.
-- Related:
--   platform/docs/data-architecture.md — leads.partials section (updated 2026-04-19)
--   switchable/site/docs/funded-funnel-architecture.md — partial capture layer
--   .claude/rules/data-infrastructure.md — governance (additive change, no payload schema bump required)
--
-- Impact assessment (per data-infrastructure.md §8):
--   1. Change: new table leads.partials; new pg_cron purge job; no existing column changed.
--   2. Readers: readonly_analytics (Metabase, agent MCPs) gains a new readable table. No existing queries break.
--   3. Writers: functions_writer (Edge Function netlify-partial-capture — ships same session) writes here. No other writers.
--   4. Schema_version: payload into this table starts at 1.0. Additive relative to all existing schemas.
--   5. Data migration: none. Empty on creation.
--   6. New role / policy: no new role. New RLS policies scoped to existing roles.
--   7. Rollback: DROP TABLE leads.partials (DOWN block below). No FK dependencies from other tables — safe.
--   8. Sign-off: Owner (session 2026-04-19). Mira architectural review APPROVE-WITH-CHANGES (all changes adopted).
--
-- Before running:
--   1. Confirm pg_cron extension is available (Supabase Pro has it by default; free tier: enable via
--      Database → Extensions). The purge schedule at the bottom of this migration requires it.
--   2. Run as the postgres superuser in the Supabase SQL editor.
--   3. Verify via the block at the bottom.

-- UP

-- =====================================================================
-- TABLE
-- =====================================================================

CREATE TABLE leads.partials (
  id              BIGSERIAL PRIMARY KEY,
  session_id      UUID NOT NULL UNIQUE,
  schema_version  TEXT NOT NULL DEFAULT '1.0',

  -- Form context
  form_name       TEXT NOT NULL,
  page_url        TEXT,
  course_id       TEXT,
  funding_route   TEXT,

  -- Progress
  step_reached    INTEGER NOT NULL DEFAULT 1,
  answers         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Attribution (UTM convention matches ads_switchable.meta_daily — see column comments)
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  utm_content     TEXT,
  fbclid          TEXT,
  gclid           TEXT,
  referrer        TEXT,

  -- Device segmentation
  user_agent      TEXT,
  device_type     TEXT,

  -- Completion flag (flipped by netlify-lead-router on matching final submit)
  is_complete     BOOLEAN NOT NULL DEFAULT false,

  -- Per-session abuse cap. Incremented on every upsert; Edge Function rejects
  -- requests once a session crosses MAX_UPSERTS_PER_SESSION. A legit session
  -- makes ~8-15 upserts (one per step, plus back-button edits); the cap gives
  -- headroom for that while blocking a single session from flooding the table.
  upsert_count    INTEGER NOT NULL DEFAULT 1,

  -- Timestamps
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  leads.partials IS 'Progressive capture of multi-step form sessions (non-PII). Upserted per session_id as the learner advances steps. Joined to leads.submissions via session_id on final submit.';
COMMENT ON COLUMN leads.partials.session_id   IS 'Random UUID generated client-side in sessionStorage. Not tied to identity. Join key to leads.submissions.session_id.';
COMMENT ON COLUMN leads.partials.answers      IS 'Non-PII step answers only (reason, interest, situation, qualification, start, budget, etc.). PII lives on leads.submissions after final submit.';
COMMENT ON COLUMN leads.partials.step_reached IS 'Highest step the learner has advanced to. Monotonic — never regresses (enforced in upsert via GREATEST).';
COMMENT ON COLUMN leads.partials.utm_campaign IS 'Meta campaign_id (per the attribution convention shared with ads_switchable.meta_daily). Enforced at ad creation by Iris, not the database.';
COMMENT ON COLUMN leads.partials.utm_content  IS 'Meta ad_id (per the attribution convention shared with ads_switchable.meta_daily). Enforced at ad creation by Iris, not the database.';
COMMENT ON COLUMN leads.partials.is_complete  IS 'True once the matching session_id lands in leads.submissions via netlify-lead-router. Otherwise false — the session abandoned.';

-- =====================================================================
-- INDEXES
-- =====================================================================

CREATE INDEX ON leads.partials (form_name, last_seen_at DESC);
CREATE INDEX ON leads.partials (last_seen_at) WHERE is_complete = false; -- drives the purge job
CREATE INDEX ON leads.partials (utm_campaign, utm_content) WHERE utm_campaign IS NOT NULL;
CREATE INDEX ON leads.partials (step_reached, is_complete);

-- =====================================================================
-- GRANTS
-- =====================================================================

-- functions_writer needs INSERT (new sessions), UPDATE (step progression + is_complete flip), SELECT (rate-limit check).
GRANT SELECT, INSERT, UPDATE ON leads.partials TO functions_writer;
GRANT USAGE, SELECT ON SEQUENCE leads.partials_id_seq TO functions_writer;

-- readonly_analytics inherits via the default-privileges grant in 0001 (ALTER DEFAULT PRIVILEGES IN SCHEMA leads GRANT SELECT ON TABLES TO readonly_analytics)
-- but defaults only apply to tables created AFTER that statement. The default was set in 0001, so this CREATE TABLE
-- picks it up. Explicit grant anyway for safety and clarity:
GRANT SELECT ON leads.partials TO readonly_analytics;

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================

ALTER TABLE leads.partials ENABLE ROW LEVEL SECURITY;

CREATE POLICY analytics_read_partials ON leads.partials
  FOR SELECT TO readonly_analytics USING (true);

CREATE POLICY functions_all_partials ON leads.partials
  FOR ALL TO functions_writer USING (true) WITH CHECK (true);

-- =====================================================================
-- RETENTION — 90-day purge of abandoned partials
-- =====================================================================
-- GDPR defensibility: answers (JSONB) + user_agent + fbclid in aggregate are
-- quasi-identifiers even though individually none is PII. Purging incomplete
-- sessions after 90 days matches the posture documented in data-architecture.md.
-- Complete partials are retained indefinitely — they join to leads.submissions
-- (which already has its own retention lifecycle via archived_at) and carry the
-- same consent posture as the resulting submission.

CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'purge-stale-partials',
  '0 3 * * *',  -- 03:00 UTC daily
  $$DELETE FROM leads.partials
    WHERE last_seen_at < now() - interval '90 days'
      AND is_complete = false$$
);

-- =====================================================================
-- VERIFICATION (run after the migration)
-- =====================================================================

--   SELECT table_schema, table_name
--     FROM information_schema.tables
--     WHERE table_schema = 'leads' AND table_name = 'partials';
--     Expected: one row.
--
--   SELECT policyname, roles FROM pg_policies
--     WHERE schemaname = 'leads' AND tablename = 'partials';
--     Expected: two rows — analytics_read_partials, functions_all_partials.
--
--   SELECT jobname, schedule, command FROM cron.job WHERE jobname = 'purge-stale-partials';
--     Expected: one row, 03:00 UTC daily.

-- DOWN
-- SELECT cron.unschedule('purge-stale-partials');
-- DROP POLICY IF EXISTS functions_all_partials ON leads.partials;
-- DROP POLICY IF EXISTS analytics_read_partials ON leads.partials;
-- DROP TABLE IF EXISTS leads.partials;
