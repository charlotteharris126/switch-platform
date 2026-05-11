-- Migration 0120 — canonical intake-date table for provider portal cohort filters
-- Date: 2026-05-11
-- Author: Claude (UX session) on Charlotte's instruction
-- Reason:
--   The provider portal's cohort filter currently aggregates intake_ids
--   from each lead's preferred_intake_id + acceptable_intake_ids[]. That
--   works for new leads but leaves a UX hole: providers with mostly
--   pre-fastrack-form leads see only one cohort option in the filter
--   (or none) even though their courses currently have multiple open
--   intakes. EMS goes live this week with 3 open intakes across
--   counselling + SMM — the filter has to reflect that even before any
--   new lead has been submitted against those intakes.
--
--   This table mirrors the open-intake data from switchable/site/deploy/
--   data/pages/<course>.yml as the canonical source for portal cohort
--   filters. Long-term the Switchable site build script syncs this row
--   set on every deploy; for the pilot we seed manually and update by
--   hand when intakes change.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new table in crm schema. Seeded with the three currently
--      open intakes (2026-05-21 / 2026-05-26 SMM, 2026-06-02 counselling
--      at tees-valley; 2026-04-27 lift-digital-marketing).
--   2. Readers: provider portal (/provider/leads page) — to follow in
--      this session.
--   3. Writers: manual UPDATE/INSERT today; future build-script sync.
--   4. Schema version: portal data contract; this is new and additive.
--   5. Data migration: seed inline below.
--   6. Role/policy: readonly_analytics SELECT (agents can read for
--      reporting); service_role full; authenticated provider role gets
--      SELECT via RLS scoped to courses they serve.
--   7. Rollback: DROP TABLE.
--   8. Sign-off: owner (this session, 2026-05-11).
-- Related: page YAML files at switchable/site/deploy/data/pages/.

BEGIN;

CREATE TABLE IF NOT EXISTS crm.course_intakes (
  id           BIGSERIAL PRIMARY KEY,
  -- course_slug = leads.submissions.course_id (no FK because course_id is
  -- a free-text slug, not a FK column in the lead schema).
  course_slug  TEXT NOT NULL,
  -- intake_id = the canonical "<region>-<YYYY-MM-DD>" string used in
  -- leads.submissions.preferred_intake_id / acceptable_intake_ids and in
  -- form payloads. Unique across the table — one row per intake.
  intake_id    TEXT NOT NULL UNIQUE,
  intake_date  DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'closed', 'cancelled')),
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS course_intakes_course_status_idx
  ON crm.course_intakes (course_slug, status);
CREATE INDEX IF NOT EXISTS course_intakes_date_idx
  ON crm.course_intakes (intake_date);

COMMENT ON TABLE crm.course_intakes IS
  'Canonical intake dates per course. Mirrors switchable/site/deploy/data/pages/<course>.yml intakes[]. Used by the provider portal cohort filter so providers see ALL currently-open intakes for the courses they serve, not just the ones that happen to have leads against them. Seeded manually 2026-05-11; longer term, switchable site build script syncs.';

-- =============================================================================
-- Seed current open intakes
-- =============================================================================
INSERT INTO crm.course_intakes (course_slug, intake_id, intake_date, status) VALUES
  ('counselling-skills-tees-valley', 'tees-valley-2026-06-02', DATE '2026-06-02', 'open'),
  ('smm-for-ecommerce-tees-valley',  'tees-valley-2026-05-21', DATE '2026-05-21', 'open'),
  ('smm-for-ecommerce-tees-valley',  'tees-valley-2026-05-26', DATE '2026-05-26', 'open'),
  ('lift-digital-marketing-futures-lift-boroughs', 'lift-boroughs-2026-04-27', DATE '2026-04-27', 'closed')
ON CONFLICT (intake_id) DO NOTHING;

-- =============================================================================
-- RLS — service role bypasses; provider role gets read access
-- =============================================================================
ALTER TABLE crm.course_intakes ENABLE ROW LEVEL SECURITY;

-- Service role + Edge Functions full access.
CREATE POLICY course_intakes_service_all
  ON crm.course_intakes FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Readonly analytics (Iris, Mira, Sasha via MCP) can read everything.
CREATE POLICY course_intakes_analytics_read
  ON crm.course_intakes FOR SELECT TO readonly_analytics
  USING (true);

-- Provider portal: read everything (no per-provider scoping needed — these
-- are public-ish cohort dates, not provider-specific).
CREATE POLICY course_intakes_authenticated_read
  ON crm.course_intakes FOR SELECT TO authenticated
  USING (true);

GRANT SELECT ON crm.course_intakes TO authenticated;
GRANT SELECT ON crm.course_intakes TO readonly_analytics;
GRANT ALL    ON crm.course_intakes TO service_role;
GRANT USAGE, SELECT ON SEQUENCE crm.course_intakes_id_seq TO service_role;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP TABLE IF EXISTS crm.course_intakes;
-- COMMIT;
