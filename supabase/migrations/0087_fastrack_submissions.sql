-- Migration 0087 — Fastrack form: client_nonce + fastracked_at on leads.submissions, new leads.fastrack_submissions table
-- Date: 2026-05-07
-- Author: Claude (Mable session) with owner sign-off
-- Reason: Lead-to-enrol uplift Phase 2 (strategy/docs/lead-to-enrol-uplift.md).
--   The funded thank-you page gains a Fastrack form that captures cohort
--   confirmation + transport-help flag, doc-checklist self-rating,
--   voice-of-learner intro for the EMS adviser, and a Personal Learner
--   Record-framed eligibility cross-check (catches the L3 leakage Daniel
--   Manning flagged for counselling-skills-tees-valley). Two operational
--   DQ paths: (a) learner self-reports a Level 3 → auto-lost reason
--   'l3_mismatch_self_reported'; (b) learner declines this cohort →
--   auto-lost reason 'cohort_decline'. The captured data feeds the EMS
--   sheet via projection columns (`fastracked` yes/no, `fastrack_notes`
--   summary, plus auto-write to `Status` + `Lost Reason` on a DQ) and
--   the back-end DB.
--
--   This migration adds:
--     1. `leads.submissions.client_nonce` UUID (nullable, indexed). Set by
--        the funded form's pre-submit JS so the post-redirect /funded/thank-you/
--        URL can carry a `?ref=<uuid>` lookup token without exposing PII.
--        Browser-generated UUIDv4; ~122 bits entropy; same security model as
--        the existing waitlist `ref_token` (email-keyed). The Edge Function
--        looks up parent submissions by this column when the fastrack form
--        posts back.
--     2. `leads.submissions.fastracked_at` TIMESTAMPTZ (nullable). Stamped
--        when a fastrack child row lands. Fast filter for "fastracked vs
--        not" without joining the child table.
--     3. `leads.fastrack_submissions` new table. One row per fastrack
--        submission, FK to parent `leads.submissions(id)`. Discrete, typed
--        columns for each captured field; sheet projection composed at
--        write-time by the Edge Function.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: additive only. Two nullable columns on submissions, one new
--      table, RLS policies, role grants. No data migration.
--   2. Readers affected: none currently. Future readers: provider sheet
--      appender (composes `fastracked` + `fastrack_notes` columns from this
--      table), admin dashboard (will surface fastrack state per lead),
--      analytics queries (Mira's funnel KPIs).
--   3. Writers affected: new Edge Function `fastrack-receive` (to be
--      deployed) writes here via `functions_writer` role. The existing
--      `netlify-lead-router` Edge Function gains a tiny addition: write
--      `client_nonce` from the incoming Netlify payload's hidden field
--      onto the submission row. Both changes spec'd in the platform
--      handoff for owner to ship.
--   4. Schema version: lead payload (switchable-funded) gains an optional
--      `client_nonce` hidden field. Per .claude/rules/schema-versioning.md,
--      additive optional fields old consumers can ignore do NOT bump the
--      version — documented in funded-funnel-architecture.md without a
--      version bump. The fastrack payload is a brand-new contract, gets
--      its own schema_version '1.0' (column default on the new table) and
--      a fresh section in the architecture doc.
--   5. Data migration: none. Existing submissions get NULL client_nonce
--      and NULL fastracked_at — both expected for pre-fastrack rows.
--   6. Role/policy: new table inherits the leads-schema convention.
--      functions_writer (Edge Function) gets ALL; readonly_analytics gets
--      SELECT; n8n_writer not granted (n8n is phasing out and never
--      handles fastrack).
--   7. Rollback: DOWN drops the table + columns. No data loss for the
--      parent rows (only new nullable columns removed).
--   8. Sign-off: owner (this session, 2026-05-07).
--
-- Related:
--   strategy/docs/lead-to-enrol-uplift.md (initiative scope)
--   switchable/site/docs/funded-funnel-architecture.md (lead payload schema 1.3)
--   switchable/site/deploy/data/form-allowlist.json (fastrack-funded-v1 form name)
--   platform/supabase/migrations/0026_lead_dedup_v1.sql (parent_submission_id pattern)
--   platform/supabase/migrations/0001_init_pilot_schemas.sql (leads.submissions base)

BEGIN;

-- 1. Additive columns on leads.submissions
ALTER TABLE leads.submissions
  ADD COLUMN IF NOT EXISTS client_nonce   UUID,
  ADD COLUMN IF NOT EXISTS fastracked_at  TIMESTAMPTZ;

-- Indexes:
--   client_nonce — point lookup from the fastrack-receive Edge Function.
--                  Partial index on NOT NULL since pre-fastrack rows are
--                  the bulk and we never look them up by this column.
--   fastracked_at — partial filter on `WHERE fastracked_at IS NOT NULL`
--                   for the funnel-conversion analytics query.
CREATE INDEX IF NOT EXISTS submissions_client_nonce_idx
  ON leads.submissions (client_nonce)
  WHERE client_nonce IS NOT NULL;

CREATE INDEX IF NOT EXISTS submissions_fastracked_at_idx
  ON leads.submissions (fastracked_at)
  WHERE fastracked_at IS NOT NULL;

COMMENT ON COLUMN leads.submissions.client_nonce IS
  'UUIDv4 generated client-side by the funded form just before submit. Sent as a hidden form field, stored on the submission row, and embedded in the post-submit /funded/thank-you/ redirect as ?ref=<uuid> so the Fastrack form can identify its parent without PII in the URL. Same security pattern as the waitlist ref_token (email-keyed). Added migration 0087.';

COMMENT ON COLUMN leads.submissions.fastracked_at IS
  'Timestamp the parent submission gained a fastrack child row. NULL until a fastrack form lands. Stamped by the fastrack-receive Edge Function alongside the child row insert. Allows funnel-conversion queries to filter without joining leads.fastrack_submissions. Added migration 0087.';

-- 2. New table: leads.fastrack_submissions
CREATE TABLE leads.fastrack_submissions (
  id                          BIGSERIAL PRIMARY KEY,
  schema_version              TEXT NOT NULL DEFAULT '1.0',
  parent_submission_id        BIGINT NOT NULL REFERENCES leads.submissions(id) ON DELETE RESTRICT,
  submitted_at                TIMESTAMPTZ NOT NULL,

  -- Cohort confirmation. true = "Yes, I can commit to this cohort";
  -- false = "I need different dates" (DQ for this round, lead auto-marked
  -- lost with reason 'cohort_decline'). Funded courses run fixed cohorts,
  -- so a "no" here is operationally a not-this-round signal.
  cohort_confirmed            BOOLEAN,

  -- Optional: learner ticked "I'd like to talk about transport help".
  -- EMS offers transport to the training venue for Tees Valley learners;
  -- this flag surfaces the request to the adviser.
  transport_help_requested    BOOLEAN,

  -- Documents readiness. true = "Yes, I have those documents";
  -- false = "No, I don't have those documents". Soft flag, NOT a DQ —
  -- "no" answers are usually recoverable (adviser clarifies what
  -- counts, learner gathers what's missing). Lead stays open on a
  -- "no" so the adviser can help; sheet's Fastrack Notes carries a
  -- `⚠ Docs gathering needed` marker.
  docs_ready                  BOOLEAN,

  -- L3 reconfirmation. Set on the fastrack form's eligibility-check
  -- question. l3_mismatch_flag = (l3_reconfirmed === true), set by
  -- the Edge Function — any "yes I have a Level 3" answer triggers
  -- the mismatch flow regardless of what the funded form said.
  l3_reconfirmed              BOOLEAN,
  l3_mismatch_flag            BOOLEAN NOT NULL DEFAULT false,

  -- Voice-of-learner free text. Surfaces to the EMS adviser as a pre-call
  -- intro. Optional. Trimmed and length-capped at the Edge Function.
  voice_of_learner_intro      TEXT,

  -- Consent. Terms (required) + marketing (presence required) per
  -- the project's hard PII consent rule. Asymmetric handling in the
  -- Edge Function: an explicit `marketing_opt_in = true` writes a
  -- fresh crm.consent_history row confirming/maintaining opt-in; a
  -- false (or NULL) does NOT downgrade prior consent. Source of truth
  -- for marketing remains the parent funded-form submission;
  -- withdrawal flows through email unsubscribe links.
  terms_accepted              BOOLEAN NOT NULL DEFAULT false,
  marketing_opt_in            BOOLEAN NOT NULL DEFAULT false,

  -- Audit
  raw_payload                 JSONB NOT NULL,
  user_agent                  TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE leads.fastrack_submissions IS
  'One row per Fastrack form submission off the funded thank-you page. Linked to the parent funded-form submission via parent_submission_id. Captures soft commitment window, doc-checklist self-rating, L3 reconfirmation (mismatches flagged for EMS adviser), and voice-of-learner intro. The fastrack-receive Edge Function inserts here, stamps leads.submissions.fastracked_at, composes the sheet projection (fastracked yes/no + fastrack_notes summary line). Added migration 0087.';

CREATE INDEX fastrack_submissions_parent_idx
  ON leads.fastrack_submissions (parent_submission_id);

CREATE INDEX fastrack_submissions_submitted_at_idx
  ON leads.fastrack_submissions (submitted_at);

-- 3. RLS + role policies (mirrors the leads-schema convention from 0001)
ALTER TABLE leads.fastrack_submissions ENABLE ROW LEVEL SECURITY;

-- Edge Functions (functions_writer) need ALL: the fastrack-receive function
-- inserts; future admin tooling may update.
GRANT SELECT, INSERT, UPDATE ON leads.fastrack_submissions TO functions_writer;
GRANT USAGE, SELECT ON SEQUENCE leads.fastrack_submissions_id_seq TO functions_writer;

CREATE POLICY functions_all_fastrack_submissions
  ON leads.fastrack_submissions
  FOR ALL TO functions_writer
  USING (true)
  WITH CHECK (true);

-- Read-only analytics (Mira, Sasha via MCP, Metabase).
GRANT SELECT ON leads.fastrack_submissions TO readonly_analytics;

CREATE POLICY analytics_read_fastrack_submissions
  ON leads.fastrack_submissions
  FOR SELECT TO readonly_analytics
  USING (true);

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS analytics_read_fastrack_submissions ON leads.fastrack_submissions;
-- DROP POLICY IF EXISTS functions_all_fastrack_submissions  ON leads.fastrack_submissions;
-- REVOKE ALL ON leads.fastrack_submissions FROM readonly_analytics;
-- REVOKE ALL ON leads.fastrack_submissions FROM functions_writer;
-- REVOKE ALL ON SEQUENCE leads.fastrack_submissions_id_seq FROM functions_writer;
-- DROP TABLE IF EXISTS leads.fastrack_submissions;
-- DROP INDEX IF EXISTS leads.submissions_client_nonce_idx;
-- DROP INDEX IF EXISTS leads.submissions_fastracked_at_idx;
-- ALTER TABLE leads.submissions DROP COLUMN IF EXISTS fastracked_at;
-- ALTER TABLE leads.submissions DROP COLUMN IF EXISTS client_nonce;
-- COMMIT;
