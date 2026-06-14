-- Migration 0208 — crm.backfill_waitlist_identity_from_parent()
-- Date: 2026-06-14
-- Author: Claude (Sasha session) with owner sign-off
-- Reason: The /waitlist/ flow stores its child enrolment row with NULL
--   first_name / last_name / postcode / region / la / current_qualification,
--   so waitlist marketing contacts render "Hi ," and aren't segmentable
--   (platform/docs/waitlist-capture-fix.md). But 44 of 45 waitlist rows carry
--   a parent_submission_id, and for all 36 opted-in ones the PARENT row holds
--   the name + postcode (100%) and qualification (~50%). This function
--   backtracks that identity from the parent onto the waitlist child, only
--   filling fields the child is missing and the parent has, then re-syncs the
--   affected contacts to Brevo so FIRSTNAME et al. stop rendering blank.
--   Course interest is deliberately NOT recovered here — only 3/36 parents
--   carry a course_id, so it isn't in the data; the going-forward router fix
--   captures course for new signups (owner decision 2026-06-14: leave existing
--   36 course-blank, no re-engagement email).
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: one SECURITY DEFINER function in crm. It UPDATEs identity
--      columns on waitlist child rows from their parent and calls the existing
--      crm.sync_leads_to_brevo on the touched ids. No schema change to tables.
--   2. Readers affected: admin leads view + Brevo segmentation gain populated
--      name/location on these 36 contacts. No reader breaks (fields were NULL).
--   3. Writers affected: none new. The function is the writer; it's idempotent
--      (COALESCE-fill only, re-running fills nothing more and returns 0).
--   4. schema_version: unchanged. No payload contract touched.
--   5. Data migration: this IS the data fix, but packaged as a repeatable
--      function rather than a one-shot UPDATE so it can be re-run safely and
--      driven from a one-click /admin/data-ops panel.
--   6. Role/policy: SECURITY DEFINER (owner) so it bypasses the admin-only
--      write RLS on leads.submissions; EXECUTE granted to authenticated, called
--      by the admin Server Action via the service-role client behind an
--      isAdmin() gate. Mirrors crm.sync_leads_to_brevo (migration 0044).
--   7. Rollback: DROP FUNCTION. The data it wrote stays (correct values copied
--      from the parent); it does not need reverting.
--   8. Sign-off: owner (this session, 2026-06-14).
--
-- Related:
--   platform/docs/waitlist-capture-fix.md (problem scope)
--   platform/supabase/migrations/0044_sync_leads_to_brevo.sql (the sync it calls)
--   platform/supabase/functions/_shared/ingest.ts (where waitlist children get
--     their parent_submission_id — the link this function relies on)

-- UP
CREATE OR REPLACE FUNCTION crm.backfill_waitlist_identity_from_parent()
RETURNS TABLE(filled_count integer, affected_ids bigint[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = crm, leads, public
AS $$
DECLARE
  v_ids bigint[];
BEGIN
  WITH upd AS (
    UPDATE leads.submissions w
       SET first_name            = COALESCE(w.first_name, p.first_name),
           last_name             = COALESCE(w.last_name,  p.last_name),
           postcode              = COALESCE(w.postcode,   p.postcode),
           region                = COALESCE(w.region,     p.region),
           la                    = COALESCE(w.la,         p.la),
           current_qualification = COALESCE(w.current_qualification, p.current_qualification),
           updated_at            = now()
      FROM leads.submissions p
     WHERE p.id = w.parent_submission_id
       AND (w.source_form = 'switchable-waitlist' OR w.dq_reason = 'waitlist_enrichment')
       AND w.marketing_opt_in = true
       AND (
            (w.first_name            IS NULL AND p.first_name            IS NOT NULL)
         OR (w.last_name             IS NULL AND p.last_name             IS NOT NULL)
         OR (w.postcode              IS NULL AND p.postcode              IS NOT NULL)
         OR (w.region                IS NULL AND p.region                IS NOT NULL)
         OR (w.la                    IS NULL AND p.la                    IS NOT NULL)
         OR (w.current_qualification IS NULL AND p.current_qualification IS NOT NULL)
       )
    RETURNING w.id
  )
  SELECT array_agg(id) INTO v_ids FROM upd;

  IF v_ids IS NOT NULL THEN
    PERFORM crm.sync_leads_to_brevo(v_ids);
  END IF;

  RETURN QUERY
    SELECT COALESCE(array_length(v_ids, 1), 0), COALESCE(v_ids, ARRAY[]::bigint[]);
END;
$$;

COMMENT ON FUNCTION crm.backfill_waitlist_identity_from_parent() IS
  'One-off-but-idempotent backfill: copies first_name/last_name/postcode/region/la/current_qualification from each opted-in waitlist child''s parent submission (filling NULLs only), then re-syncs the touched ids to Brevo via crm.sync_leads_to_brevo. Returns the count + ids filled. Course interest deliberately excluded (not in the data). Migration 0208.';

REVOKE ALL ON FUNCTION crm.backfill_waitlist_identity_from_parent() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.backfill_waitlist_identity_from_parent() TO authenticated;

-- DOWN
-- DROP FUNCTION IF EXISTS crm.backfill_waitlist_identity_from_parent();
