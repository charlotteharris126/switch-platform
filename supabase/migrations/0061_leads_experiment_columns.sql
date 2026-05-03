-- Migration 0061 — leads.submissions: add experiment_id + experiment_variant
-- Date: 2026-05-03
-- Author: Claude (session) with owner review
-- Reason: Foundation for site-controlled A/B testing on Switchable funded /
--   self-funded / loan-funded landing pages. The Edge Function that fronts
--   `/funded/*` (planned, separate session) hashes each visitor into variant A
--   or B, sets a sticky cookie, and rewrites the response to serve the
--   variant's HTML. The form on the page carries two new hidden inputs
--   (`experiment_id`, `experiment_variant`) populated from that cookie. Those
--   land in these two columns so leads can be grouped by experiment + variant
--   for conversion-rate / CPL analysis.
--
--   Both columns are TEXT and nullable. Default null. Pages with no live
--   experiment leave them null, exactly as today's submissions look. No
--   existing row is touched.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: 2 new nullable TEXT columns on `leads.submissions`. Partial
--      index on `experiment_id` (only non-null rows) to keep index small while
--      experiments are sparse.
--   2. Readers affected: none today. Future readers — the planned
--      `/admin/experiments/` page in `platform/app/`, Iris weekly notes (CPL
--      by variant breakdown), and any agent querying experiment performance.
--      All addition-only; no existing query references these columns yet.
--   3. Writers: `_shared/ingest.ts` (the shared insert path for both
--      `netlify-lead-router` and `netlify-leads-reconcile`). Function update
--      ships in a separate session once the form-side hidden fields are in
--      place; until then, INSERTs leave both columns null.
--   4. Schema_version: lead payload schema is currently documented at 1.2
--      (cohort-aware intake fields) per migration 0041. The two new fields
--      are additive optional payload fields per
--      `.claude/rules/schema-versioning.md` — no version bump required. The
--      funded-funnel-architecture doc gets an additive note for the new
--      optional fields in the same session.
--   5. Data migration: none. Existing rows stay null forever (no historical
--      experiment data exists, by definition).
--   6. Role/policy: no new role. No RLS change needed — leads.submissions
--      already has its policy set; new columns inherit the table's policy.
--   7. Rollback: DROP COLUMN ... in DOWN. Safe before any experiment runs;
--      after experiments are live, dropping these columns destroys variant
--      attribution on historical leads (manual on-demand backup first per
--      .claude/rules/data-infrastructure.md §7).
--   8. Sign-off: owner (this session).
--
-- Related:
--   switchable/site/docs/funded-funnel-architecture.md (gets additive note)
--   platform/docs/data-architecture.md (gets the two columns + index)
--   platform/docs/changelog.md (entry at top)
--   Future: experiment manifest + Edge Function + hidden form fields +
--   /admin/experiments/ page (separate sessions)
-- =============================================================================

BEGIN;

ALTER TABLE leads.submissions
  ADD COLUMN experiment_id      TEXT,
  ADD COLUMN experiment_variant TEXT;

COMMENT ON COLUMN leads.submissions.experiment_id IS
  'Identifier of the running A/B experiment this submission was part of, e.g. "counselling-tees-hero-rework-2026-05". NULL when the page had no live experiment at submission time. Populated from the experiment cookie set by the variant-routing Edge Function and carried into the form as a hidden input. Migration 0061.';

COMMENT ON COLUMN leads.submissions.experiment_variant IS
  'Variant the visitor was served when this submission landed: "a" (canonical / control) or "b" (challenger). NULL when experiment_id is NULL. Migration 0061.';

-- Partial index: only rows that are part of an experiment. Keeps index tiny
-- while experiments are sparse (one or two pages running at a time, most
-- traffic untouched). Composite (experiment_id, experiment_variant) lets the
-- analytics page do "leads per variant within experiment X" with an index-only
-- scan.
CREATE INDEX leads_submissions_experiment_idx
  ON leads.submissions (experiment_id, experiment_variant)
  WHERE experiment_id IS NOT NULL;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- Safe before any experiment runs (no data lost, columns are 100% null).
-- After experiments have collected data, dropping these columns destroys
-- per-variant attribution on historical rows. Take a manual on-demand backup
-- first per .claude/rules/data-infrastructure.md §7.
--
-- BEGIN;
-- DROP INDEX IF EXISTS leads.leads_submissions_experiment_idx;
-- ALTER TABLE leads.submissions
--   DROP COLUMN experiment_variant,
--   DROP COLUMN experiment_id;
-- COMMIT;
