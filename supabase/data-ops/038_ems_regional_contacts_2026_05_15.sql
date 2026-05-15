-- Data-ops 038, populate EMS regional_contacts
-- Date:   2026-05-15
-- Owner:  Charlotte
-- Reason:
--   Migration 0145 added crm.providers.regional_contacts JSONB.
--   EMS routes Tees Valley learners across three reps:
--     George Taylor   stockton-on-tees, hartlepool      07955 265 739
--     Jake Balfour    middlesbrough, darlington         07931 601 801
--     Nick Rodgers    redcar-and-cleveland              07842 444 808
--
--   Flat-by-LA shape so route-lead.ts can do a single key lookup
--   against submission.la (the form stores LA as a slug, matching
--   the keys below).
--
--   The "other" LA option on Tees Valley funded forms (None of
--   these) is DQ-routed and never reaches a provider, so no entry
--   is needed for it.
--
-- Pre-condition: migration 0145 applied.

BEGIN;

-- 1. Preview the current state.
SELECT provider_id, company_name, regional_contacts
  FROM crm.providers
 WHERE provider_id = 'enterprise-made-simple';

-- 2. Set the regional contact mapping.
UPDATE crm.providers
   SET regional_contacts = jsonb_build_object(
         'by_la', jsonb_build_object(
           'stockton-on-tees',     jsonb_build_object('first_name', 'George', 'name', 'George Taylor', 'phone', '07955 265 739'),
           'hartlepool',           jsonb_build_object('first_name', 'George', 'name', 'George Taylor', 'phone', '07955 265 739'),
           'middlesbrough',        jsonb_build_object('first_name', 'Jake',   'name', 'Jake Balfour',  'phone', '07931 601 801'),
           'darlington',           jsonb_build_object('first_name', 'Jake',   'name', 'Jake Balfour',  'phone', '07931 601 801'),
           'redcar-and-cleveland', jsonb_build_object('first_name', 'Nick',   'name', 'Nick Rodgers',  'phone', '07842 444 808')
         )
       ),
       updated_at = now()
 WHERE provider_id = 'enterprise-made-simple';

-- 3. Audit row.
SELECT audit.log_system_action(
  'data_ops:038',
  'set_regional_contacts',
  'crm.providers',
  'enterprise-made-simple',
  jsonb_build_object('regional_contacts', NULL),
  jsonb_build_object('regional_contacts', 'set'),
  jsonb_build_object(
    'provider_id', 'enterprise-made-simple',
    'source', 'data_ops:038_ems_regional_contacts_2026_05_15',
    'reason', 'Initial population of crm.providers.regional_contacts for EMS, George/Jake/Nick Tees Valley LA mapping'
  )
);

-- 4. Verification, row now non-null and well-formed.
SELECT provider_id,
       company_name,
       regional_contacts -> 'by_la' -> 'stockton-on-tees'     AS stockton,
       regional_contacts -> 'by_la' -> 'hartlepool'           AS hartlepool,
       regional_contacts -> 'by_la' -> 'middlesbrough'        AS middlesbrough,
       regional_contacts -> 'by_la' -> 'darlington'           AS darlington,
       regional_contacts -> 'by_la' -> 'redcar-and-cleveland' AS redcar
  FROM crm.providers
 WHERE provider_id = 'enterprise-made-simple';

COMMIT;
