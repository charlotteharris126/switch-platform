-- Migration 0098 — Auto-sync DB → Brevo via Postgres triggers
-- Date:    2026-05-09
-- Author:  Claude (platform Session 36) on Charlotte's instruction
-- Reason:  Charlotte's principle 2026-05-09: "every time anything changes
--          which therefore changes a Brevo attribute, we push to Brevo so
--          the right automation triggers." Until now the push has been
--          discipline-based — Server Actions and Edge Functions had to
--          remember to call crm.sync_leads_to_brevo after writing. This
--          migration makes it structural: any write to crm.enrolments,
--          leads.submissions (Brevo-relevant fields), or crm.providers
--          (cascade fields) auto-fires the sync via Postgres trigger.
--
--          Three triggers, one function each:
--            1. crm.enrolments INSERT/UPDATE → sync the affected submission
--               (the row that changed status / lost_reason / outcome state)
--            2. leads.submissions UPDATE → sync if a Brevo-mapped field
--               changed (consent, DQ, archive, course, funding, employment,
--               outcome_interest, name, email, primary_routed_to, referral)
--            3. crm.providers UPDATE → cascade-sync every contact routed to
--               that provider if a downstream-visible field changed
--               (company_name, trust_line, funding_types, regions). Catches
--               the "owner edits a provider trust line" case where 100+
--               contacts need their SW_PROVIDER_TRUST_LINE refreshed.
--
--          Why this is safe:
--          - crm.sync_leads_to_brevo is async (pg_net.http_post returns
--            immediately, the Edge Function runs separately). Triggers
--            don't block the originating write.
--          - admin-brevo-resync is idempotent (Brevo's `updateEnabled`
--            flag re-pushes the contact each time without creating
--            duplicates). Double-firing from both a Server Action AND a
--            trigger is wasteful but not broken.
--          - Triggers use IS DISTINCT FROM so unchanged-but-touched rows
--            (e.g. a no-op UPDATE setting status to its current value)
--            don't fire spurious syncs.
--
--          Consent column on submissions: marketing_opt_in IS included in
--          the trigger's WHEN clause as belt-and-braces. The brevo-event-
--          webhook + daily consent reconcile cron already keep this in
--          sync, but if a future code path edits marketing_opt_in directly
--          and bypasses the webhook, the trigger catches it.
--
--          Server Actions and Edge Functions that currently call
--          sync_leads_to_brevo explicitly (e.g. enrolment-outcome) still
--          fire it — left in place this session because removing them
--          requires touching app code and we want to ship triggers first
--          and verify they work. Cleanup of the redundant explicit calls
--          can ship in a later session once triggers are proven.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: 3 trigger functions + 3 triggers. No table changes, no data
--      migration. Existing app code unchanged.
--   2. Readers / Writers: every existing write path to the three tables
--      now triggers an additional async Brevo push. No blocking.
--   3. Schema version: not affected.
--   4. Data migration: none.
--   5. Role/policy: triggers run with table-owner privilege; they call
--      crm.sync_leads_to_brevo which is already SECURITY DEFINER.
--   6. Rollback: DROP TRIGGER + DROP FUNCTION. Reverts to discipline-based
--      pushes (existing Server Action calls remain unchanged).
--   7. Sign-off: owner (this session, 2026-05-09).
-- Related: provider-portal-mvp-scoping.md (portal Server Actions inherit
--          this safety net automatically), brevo-consent-reconcile-daily
--          (still authoritative for consent), switchable/email/docs/
--          brevo-attribute-architecture.md (Wren's reference for which
--          attributes are auto-current vs cascade-refreshed).

BEGIN;

-- =============================================================================
-- 1. Trigger function: crm.enrolments INSERT/UPDATE → sync the submission
-- =============================================================================

CREATE OR REPLACE FUNCTION crm.tg_enrolments_brevo_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Always fire on insert: new enrolment row means SW_ENROL_STATUS goes
    -- from null/missing to a real value, Brevo automations might be waiting.
    PERFORM crm.sync_leads_to_brevo(ARRAY[NEW.submission_id]);
  ELSIF TG_OP = 'UPDATE' THEN
    -- Only fire if a Brevo-mapped field actually changed. status is the
    -- big one (drives SW_ENROL_STATUS); lost_reason flows in as well so
    -- terminal-state branching automations see it.
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.lost_reason IS DISTINCT FROM OLD.lost_reason THEN
      PERFORM crm.sync_leads_to_brevo(ARRAY[NEW.submission_id]);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION crm.tg_enrolments_brevo_sync() IS
  'AFTER INSERT/UPDATE trigger function on crm.enrolments. Fires crm.sync_leads_to_brevo(ARRAY[NEW.submission_id]) when status or lost_reason changes (UPDATE), or on any new row (INSERT). Async via pg_net. Added migration 0098.';

CREATE TRIGGER enrolments_brevo_sync
  AFTER INSERT OR UPDATE ON crm.enrolments
  FOR EACH ROW
  EXECUTE FUNCTION crm.tg_enrolments_brevo_sync();

-- =============================================================================
-- 2. Trigger function: leads.submissions UPDATE → sync if Brevo-mapped field changed
-- =============================================================================

CREATE OR REPLACE FUNCTION leads.tg_submissions_brevo_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm, leads, public
AS $$
BEGIN
  -- Fire only if a Brevo-mapped field changed. List below mirrors what
  -- _shared/route-lead.ts pushes as SW_* attributes (plus marketing_opt_in
  -- which drives SW_CONSENT_MARKETING and the channel-state subscription).
  IF NEW.email IS DISTINCT FROM OLD.email
     OR NEW.first_name IS DISTINCT FROM OLD.first_name
     OR NEW.last_name IS DISTINCT FROM OLD.last_name
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
     OR NEW.interest IS DISTINCT FROM OLD.interest THEN
    PERFORM crm.sync_leads_to_brevo(ARRAY[NEW.id]);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION leads.tg_submissions_brevo_sync() IS
  'AFTER UPDATE trigger function on leads.submissions. Fires crm.sync_leads_to_brevo(ARRAY[NEW.id]) when any Brevo-mapped field changes (email/name/course/funding/employment/intent/DQ/archive/consent/routing/referral/intake/interest). Async via pg_net. Added migration 0098.';

CREATE TRIGGER submissions_brevo_sync
  AFTER UPDATE ON leads.submissions
  FOR EACH ROW
  EXECUTE FUNCTION leads.tg_submissions_brevo_sync();

-- =============================================================================
-- 3. Trigger function: crm.providers UPDATE → cascade-sync routed contacts
-- =============================================================================

CREATE OR REPLACE FUNCTION crm.tg_providers_brevo_cascade()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm, leads, public
AS $$
DECLARE
  v_submission_ids BIGINT[];
BEGIN
  -- Cascade when a downstream-visible attribute changes. company_name and
  -- trust_line drive SW_PROVIDER_NAME / SW_PROVIDER_TRUST_LINE directly.
  -- funding_types and regions don't currently map to a Brevo attribute
  -- per-contact, but route-lead.ts does read them at routing time, so
  -- changes are still worth a cascade for future-proofing if attributes
  -- get added later. Cheap to include now.
  IF NEW.company_name IS DISTINCT FROM OLD.company_name
     OR NEW.trust_line IS DISTINCT FROM OLD.trust_line
     OR NEW.funding_types IS DISTINCT FROM OLD.funding_types
     OR NEW.regions IS DISTINCT FROM OLD.regions THEN

    SELECT array_agg(id) INTO v_submission_ids
      FROM leads.submissions
     WHERE primary_routed_to = NEW.provider_id
       AND archived_at IS NULL
       AND COALESCE(is_dq, false) = false;

    IF v_submission_ids IS NOT NULL AND array_length(v_submission_ids, 1) > 0 THEN
      PERFORM crm.sync_leads_to_brevo(v_submission_ids);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION crm.tg_providers_brevo_cascade() IS
  'AFTER UPDATE trigger function on crm.providers. When company_name / trust_line / funding_types / regions change, fires crm.sync_leads_to_brevo for every routed-active submission of that provider. Cascade refreshes downstream-visible attributes for the whole cohort. Async via pg_net. Added migration 0098.';

CREATE TRIGGER providers_brevo_cascade
  AFTER UPDATE ON crm.providers
  FOR EACH ROW
  EXECUTE FUNCTION crm.tg_providers_brevo_cascade();

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP TRIGGER IF EXISTS providers_brevo_cascade ON crm.providers;
-- DROP TRIGGER IF EXISTS submissions_brevo_sync ON leads.submissions;
-- DROP TRIGGER IF EXISTS enrolments_brevo_sync ON crm.enrolments;
-- DROP FUNCTION IF EXISTS crm.tg_providers_brevo_cascade();
-- DROP FUNCTION IF EXISTS leads.tg_submissions_brevo_sync();
-- DROP FUNCTION IF EXISTS crm.tg_enrolments_brevo_sync();
-- COMMIT;
