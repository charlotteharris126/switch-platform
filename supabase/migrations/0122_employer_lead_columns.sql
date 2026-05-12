-- Migration 0122 — employer-lead schema additions for Switchable for Business v1
-- Date: 2026-05-11
-- Author: Claude (Sasha session) for Mable's S4B Wed 13 May launch
-- Reason:
--   Switchable for Business launches Wed 13 May. Form `s4b-employer-lead-v1`
--   captures B2B employer enquiries for Riverside Training (apprenticeship
--   Employer Lead route). Per the schema decision documented in this session,
--   we keep ONE leads.submissions table with a `lead_type` discriminator
--   rather than spinning up a parallel employer table — RLS, portal queries,
--   and Brevo wiring stay on a single code path.
--
--   This migration adds:
--     - lead_type discriminator ('learner' default for existing rows;
--       'employer_apprenticeship' for new B2B inserts)
--     - employer-shape columns (NULL for learner rows)
--     - routing_outcome columns to mark disqualified-vs-routed at insert
--     - terms_accepted_at timestamp for B2B audit trail
--     - index on lead_type for filtering
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: 16 new nullable columns + lead_type discriminator + 1 index
--      on leads.submissions. All additive.
--   2. Readers: provider portal (lead detail + leads list), Brevo attribute
--      reconcile, all admin views. None break — existing queries don't
--      reference the new columns; new columns NULL on existing rows.
--   3. Writers: netlify-employer-lead-router (new), netlify-lead-router
--      (continues writing lead_type='learner' implicitly via default).
--   4. Schema version: leads payload schema v1.0 for B2B
--      (switchable/site/docs/switchable-for-business/employer-lead-schema-v1.md).
--   5. Data migration: none required. Existing rows take lead_type='learner'
--      via column DEFAULT. No backfill.
--   6. Role/policy: existing RLS on leads.submissions (scoped by
--      primary_routed_to) covers new columns. No new policies.
--   7. Rollback: DROP COLUMN block in DOWN section.
--   8. Sign-off: owner pending (this session, 2026-05-11).
-- Related: switchable/site/docs/switchable-for-business/note-for-sasha.md,
--          platform/supabase/functions/netlify-employer-lead-router/

BEGIN;

-- Lead-type discriminator. 'learner' is the default for all existing rows
-- and any future B2C funded/self-funded/loan-funded submission.
-- 'employer_apprenticeship' tags rows from the s4b-employer-lead-v1 form.
ALTER TABLE leads.submissions
  ADD COLUMN IF NOT EXISTS lead_type TEXT NOT NULL DEFAULT 'learner';

-- Employer-shape columns. All NULL on learner rows.
-- `interest` already exists from earlier learner work; B2B reuses it with
-- different value space (existing_employee_upskilling, new_hire_apprentice,
-- both, not_sure_yet) — lead_type discriminates safely.
ALTER TABLE leads.submissions
  ADD COLUMN IF NOT EXISTS company_name         TEXT,
  ADD COLUMN IF NOT EXISTS company_size_band    TEXT,
  ADD COLUMN IF NOT EXISTS role_title           TEXT,
  ADD COLUMN IF NOT EXISTS sector               TEXT,
  ADD COLUMN IF NOT EXISTS levy_status          TEXT,
  ADD COLUMN IF NOT EXISTS urgency              TEXT,
  ADD COLUMN IF NOT EXISTS candidate_in_mind    TEXT,
  ADD COLUMN IF NOT EXISTS existing_apprentices TEXT,
  ADD COLUMN IF NOT EXISTS headcount_estimate   TEXT,
  ADD COLUMN IF NOT EXISTS standards_interested TEXT,
  ADD COLUMN IF NOT EXISTS additional_notes     TEXT,
  ADD COLUMN IF NOT EXISTS ern                  TEXT DEFAULT '';

-- Routing outcome at insert. 'routed' fires sheet append + provider notify
-- + employer ack. 'disqualified' fires only the polite ack to the submitter.
-- For learner rows this stays NULL (is_dq + dq_reason already serve the
-- equivalent purpose).
ALTER TABLE leads.submissions
  ADD COLUMN IF NOT EXISTS routing_outcome      TEXT
    CHECK (routing_outcome IS NULL OR routing_outcome IN ('routed', 'disqualified')),
  ADD COLUMN IF NOT EXISTS routing_outcome_hint TEXT;

-- terms_accepted_at: B2B audit trail. Captured at insert time when the form
-- carries terms_accepted=true. NULL on learner rows (the existing
-- terms_accepted boolean covers them).
ALTER TABLE leads.submissions
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

-- Index for lead_type filtering. Used by portal queries that scope by
-- lead_type for employer-shape rendering.
CREATE INDEX IF NOT EXISTS submissions_lead_type_idx
  ON leads.submissions (lead_type)
  WHERE archived_at IS NULL;

COMMENT ON COLUMN leads.submissions.lead_type IS
  'Discriminator: ''learner'' (B2C, default) or ''employer_apprenticeship'' (B2B, S4B v1). New types added as new B2B verticals ship.';

COMMIT;

-- DOWN
-- BEGIN;
-- DROP INDEX IF EXISTS leads.submissions_lead_type_idx;
-- ALTER TABLE leads.submissions
--   DROP COLUMN IF EXISTS lead_type,
--   DROP COLUMN IF EXISTS company_name,
--   DROP COLUMN IF EXISTS company_size_band,
--   DROP COLUMN IF EXISTS role_title,
--   DROP COLUMN IF EXISTS sector,
--   DROP COLUMN IF EXISTS levy_status,
--   DROP COLUMN IF EXISTS urgency,
--   DROP COLUMN IF EXISTS candidate_in_mind,
--   DROP COLUMN IF EXISTS existing_apprentices,
--   DROP COLUMN IF EXISTS headcount_estimate,
--   DROP COLUMN IF EXISTS standards_interested,
--   DROP COLUMN IF EXISTS additional_notes,
--   DROP COLUMN IF EXISTS ern,
--   DROP COLUMN IF EXISTS routing_outcome,
--   DROP COLUMN IF EXISTS routing_outcome_hint,
--   DROP COLUMN IF EXISTS terms_accepted_at;
-- COMMIT;
