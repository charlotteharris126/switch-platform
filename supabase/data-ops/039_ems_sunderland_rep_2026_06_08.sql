-- Data-ops 039, add EMS Sunderland regional rep (Andrea Clarke)
-- Date:   2026-06-08
-- Owner:  Charlotte
-- Reason:
--   New funded course "Introduction to Management" (course_id team-leading,
--   slug introduction-to-management-sunderland) is Sunderland-only and routes
--   to EMS. The learner SMS + the welcome email's "who's calling" line resolve
--   a regional rep via crm.providers.regional_contacts.by_la[submission.la]
--   (route-lead.ts renderProviderContactValues). With no Sunderland entry the
--   fastrack/chaser SMS is SKIPPED ("no regional rep phone for submission.la")
--   and the email falls back to a generic line. Add Sunderland → Andrea Clarke.
--
--     Andrea Clarke   sunderland   07792 102 367
--
--   ADD only (jsonb_set), preserving the five Tees Valley LAs from data-ops 038.
--   LA key is the lowercase slug the form stores (matches the 038 keys).
--
-- Pre-condition: data-ops 038 applied (the by_la object exists).
-- Apply: run in the Supabase SQL editor (same as 038), before the team-leading
--   page goes live. Page is currently held, so no leads are flowing yet.

BEGIN;

-- 1. Preview current state.
SELECT provider_id, company_name, jsonb_pretty(regional_contacts) AS before
  FROM crm.providers
 WHERE provider_id = 'enterprise-made-simple';

-- 2. Add the Sunderland rep (preserves existing LAs).
UPDATE crm.providers
   SET regional_contacts = jsonb_set(
         COALESCE(regional_contacts, jsonb_build_object('by_la', '{}'::jsonb)),
         '{by_la,sunderland}',
         jsonb_build_object('first_name', 'Andrea', 'name', 'Andrea Clarke', 'phone', '07792 102 367'),
         true
       ),
       updated_at = now()
 WHERE provider_id = 'enterprise-made-simple';

-- 3. Audit row.
SELECT audit.log_system_action(
  'data_ops:039',
  'set_regional_contacts',
  'crm.providers',
  'enterprise-made-simple',
  jsonb_build_object('by_la.sunderland', NULL),
  jsonb_build_object('by_la.sunderland', 'set'),
  jsonb_build_object(
    'provider_id', 'enterprise-made-simple',
    'source', 'data_ops:039_ems_sunderland_rep_2026_06_08',
    'reason', 'Add Sunderland regional rep Andrea Clarke for the team-leading course'
  )
);

-- 4. Verification: Sunderland present, Tees Valley LAs intact.
SELECT regional_contacts -> 'by_la' -> 'sunderland'            AS sunderland,
       regional_contacts -> 'by_la' -> 'stockton-on-tees'     AS stockton,
       regional_contacts -> 'by_la' -> 'redcar-and-cleveland' AS redcar
  FROM crm.providers
 WHERE provider_id = 'enterprise-made-simple';

COMMIT;
