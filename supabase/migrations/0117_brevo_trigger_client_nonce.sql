-- Migration 0117 — Add client_nonce to leads.tg_submissions_brevo_sync WHEN clause
-- Date: 2026-05-11
-- Author: Claude (Block B SSOT proper-fix) with owner sign-off
-- Reason:
--   Audit found a silent DB ↔ Brevo drift surface. `leads.submissions.client_nonce`
--   is the UUID that buildFastrackUrl() in _shared/route-lead.ts uses to compose
--   the SW_FASTRACK_URL Brevo contact attribute. The funded form POST path sets
--   client_nonce on INSERT, but the run-024 (and any future) backfill path UPDATEs
--   it on existing rows. Migration 0098/0099 trigger function omitted client_nonce
--   from its DISTINCT-FROM list, so backfill UPDATEs do NOT fire crm.sync_leads_to_brevo
--   and Brevo holds a stale SW_FASTRACK_URL until somebody clicks the run-024 panel.
--
--   This bit Charlotte on 2026-05-09 with broken fastrack URLs in marketing
--   emails (memory: feedback_url_features_click_test_before_shipped.md). The
--   compensating run-024 panel is manual + remembered. Proper fix: add the
--   field to the trigger's WHEN clause so any future UPDATE auto-syncs.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: extends WHEN clause of leads.tg_submissions_brevo_sync to fire
--      on client_nonce changes. No schema column change; trigger body only.
--   2. Readers: crm.sync_leads_to_brevo (Brevo upsert path); the rule downstream
--      is that any contact-attribute-producing function that reads client_nonce
--      (currently buildFastrackUrl) gets refreshed on every UPDATE.
--   3. Writers: route-lead.ts, fastrack-receive, backfill-client-nonce Edge
--      Functions. All three previously left Brevo stale on UPDATE.
--   4. Schema version: payload contract unchanged.
--   5. Data migration: not required. Existing stale Brevo values will refresh
--      on the next UPDATE that touches the same row (the trigger doesn't run
--      retrospectively). A one-shot resync via crm.sync_leads_to_brevo against
--      the rows with non-null client_nonce will clear the existing backlog
--      cleanly — recommended after this migration applies.
--   6. Role/policy: trigger is SECURITY DEFINER, unchanged.
--   7. Rollback: restore prior WHEN clause (drop the client_nonce line) via a
--      forward migration. Listed in DOWN section.
--   8. Sign-off: owner (this session, 2026-05-11).
--
-- Related: migration 0098 (original trigger), 0099 (last WHEN-clause extension),
--          _shared/route-lead.ts buildFastrackUrl().

BEGIN;

CREATE OR REPLACE FUNCTION leads.tg_submissions_brevo_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm, leads, public
AS $$
BEGIN
  -- Fires only if a Brevo-mapped field changed. Mirrors what _shared/route-lead.ts
  -- pushes as SW_* attributes. Any new attribute that reads a submissions column
  -- needs that column added here.
  IF NEW.email IS DISTINCT FROM OLD.email
     OR NEW.first_name IS DISTINCT FROM OLD.first_name
     OR NEW.last_name IS DISTINCT FROM OLD.last_name
     OR NEW.phone IS DISTINCT FROM OLD.phone
     OR NEW.course_id IS DISTINCT FROM OLD.course_id
     OR NEW.funding_category IS DISTINCT FROM OLD.funding_category
     OR NEW.funding_route IS DISTINCT FROM OLD.funding_route
     OR NEW.employment_status IS DISTINCT FROM OLD.employment_status
     OR NEW.outcome_interest IS DISTINCT FROM OLD.outcome_interest
     OR NEW.is_dq IS DISTINCT FROM OLD.is_dq
     OR NEW.dq_reason IS DISTINCT FROM OLD.dq_reason
     OR NEW.archived_at IS DISTINCT FROM OLD.archived_at
     OR NEW.marketing_opt_in IS DISTINCT FROM OLD.marketing_opt_in
     OR NEW.primary_routed_to IS DISTINCT FROM OLD.primary_routed_to
     OR NEW.referral_code IS DISTINCT FROM OLD.referral_code
     OR NEW.preferred_intake_id IS DISTINCT FROM OLD.preferred_intake_id
     OR NEW.interest IS DISTINCT FROM OLD.interest
     OR NEW.start_timing IS DISTINCT FROM OLD.start_timing
     OR NEW.interest_breadth IS DISTINCT FROM OLD.interest_breadth
     OR NEW.investment_willingness IS DISTINCT FROM OLD.investment_willingness
     OR NEW.current_qualification IS DISTINCT FROM OLD.current_qualification
     OR NEW.fastracked_at IS DISTINCT FROM OLD.fastracked_at
     -- Added migration 0117: client_nonce feeds buildFastrackUrl which
     -- produces SW_FASTRACK_URL. Backfilling client_nonce without firing
     -- a resync left Brevo holding stale fastrack URLs.
     OR NEW.client_nonce IS DISTINCT FROM OLD.client_nonce THEN
    PERFORM crm.sync_leads_to_brevo(ARRAY[NEW.id]);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION leads.tg_submissions_brevo_sync() IS
  'AFTER UPDATE trigger function on leads.submissions. Fires crm.sync_leads_to_brevo(ARRAY[NEW.id]) when any Brevo-mapped field changes. Original migration 0098; extended 0099 (phone, fastracked_at, 4 enrichment fields); extended 0117 (client_nonce, source for SW_FASTRACK_URL). Async via pg_net.';

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- CREATE OR REPLACE FUNCTION leads.tg_submissions_brevo_sync() ...
-- (restore body from migration 0099 lines 86-122, omitting the client_nonce line)
-- COMMIT;
