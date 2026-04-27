-- Migration 0011 - Extend leads.submissions with self-funded canonical columns
-- Date: 2026-04-21 (Session 5)
-- Author: Claude (Session 5) with owner review
-- Reason: Self-funded submissions (switchable-self-funded) currently persist the
--         learner preference fields (postcode, reason, interest, situation,
--         qualification, start_when, budget, courses_selected) inside
--         raw_payload only. Adding dedicated columns lets routing-confirm +
--         Apps Script v2 + Metabase read these without JSON parsing, and
--         lets the provider sheet headers pick them up via FIELD_MAP rather
--         than forcing a separate Apps Script per provider shape.
--
--         Also adds `region` as a nullable column. The router does NOT
--         populate it yet - Session 5.1 loads reference.postcodes and turns
--         on the JOIN. Until then, region stays NULL.
--
-- Related:
--   - platform/docs/data-architecture.md  (leads.submissions section updated)
--   - switchable/site/docs/funded-funnel-architecture.md (payload schema 1.1)
--   - platform/docs/changelog.md  (Session 5 entry with full §8 assessment)
--
-- Nature: purely additive. No existing column renamed, removed, or retyped.
-- No existing consumer (router, routing-confirm, reconcile, Sasha, Metabase)
-- reads these columns today; they are safe to add without coordinated deploys.
--
-- Schema_version bump on the payload contract: 1.0 → 1.1 (minor, additive).
-- Applied in the router code (_shared/ingest.ts) in the Session 5 deploy, not
-- in this migration - the DB column is lenient about which schema_version
-- flag the producer sends.
--
-- RLS: leads.submissions is SELECT-open to readonly_analytics and
-- INSERT/UPDATE-scoped to functions_writer via existing policies. New columns
-- inherit these policies automatically (PostgreSQL column-level defaults).
-- No new policy needed.

-- UP
ALTER TABLE leads.submissions
  ADD COLUMN postcode          TEXT,
  ADD COLUMN region            TEXT,
  ADD COLUMN reason            TEXT,
  ADD COLUMN interest          TEXT,
  ADD COLUMN situation         TEXT,
  ADD COLUMN qualification     TEXT,
  ADD COLUMN start_when        TEXT,
  ADD COLUMN budget            TEXT,
  ADD COLUMN courses_selected  TEXT[];

-- No indexes on the new columns yet. Query volume during pilot does not
-- justify them. Session 5.1 will add an index on (region, submitted_at) if
-- Iris's regional reporting requires it; `postcode` is looked up via JOIN
-- once reference.postcodes exists, not via an index on submissions.

-- DOWN
-- ALTER TABLE leads.submissions
--   DROP COLUMN courses_selected,
--   DROP COLUMN budget,
--   DROP COLUMN start_when,
--   DROP COLUMN qualification,
--   DROP COLUMN situation,
--   DROP COLUMN interest,
--   DROP COLUMN reason,
--   DROP COLUMN region,
--   DROP COLUMN postcode;
-- Safe to run - columns hold additive data only; no downstream consumer
-- depends on their presence at the time of writing. If anything has started
-- reading them in production, remove that consumer before dropping.
