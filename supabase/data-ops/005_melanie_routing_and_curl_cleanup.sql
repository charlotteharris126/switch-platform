-- data-ops 005 — Melanie Watson direct back-fill + routing + Session 3.3 curl test cleanup
-- Date: 2026-04-21
-- Author: Claude (Session 3.3) with owner authorisation
--
-- Reason:
--   (1) Melanie Watson (SMM for E-commerce, Tees Valley) submitted switchable-funded at
--       2026-04-21 15:35 UTC. Netlify's outgoing webhook was auto-disabled at the time
--       (6 consecutive non-2xx from the router; root cause = Brevo-slowness holding
--       Netlify's webhook past its 10s timeout). Submission landed in Netlify's store
--       but never reached leads.submissions via the fast path. Owner handled manually
--       outside the DB: row pasted into EMS's sheet, PII-free email sent to Andy Fay.
--       This file back-fills leads.submissions + leads.routing_log so the DB reflects
--       reality. See Session 3.3 entry in platform/docs/changelog.md.
--
--   (2) During Session 3.3 verification of the refactored netlify-lead-router, a curl
--       POST was made against the function to confirm the new ON CONFLICT syntax.
--       That created submission id 43 (email curltest@switchable.careers, auto-DQ'd
--       as owner_test_submission). Inert but untidy — removed here.
--
-- Related:
--   - platform/docs/changelog.md — 2026-04-21 Session 3.3 entry
--   - platform/supabase/data-ops/003_backfill_lucy_and_test_rows.sql — same Lucy pattern
--   - platform/supabase/functions/netlify-leads-reconcile/index.ts — session_id dedup
--     means this direct INSERT won't be duplicated by the next reconcile run
--
-- How the reconcile-duplicate concern is addressed:
--   - This INSERT captures Melanie's session_id (7947fc72-a93d-42ef-a192-77097e4909db)
--     from her client-tracker payload.
--   - The reconcile Edge Function was updated (this session) to dedupe by session_id
--     in addition to raw_payload->>'id'. So when reconcile runs at 18:30 UTC and pulls
--     Melanie's submission from Netlify's API, it'll match on session_id and skip.
--
-- Pattern: data fix per .claude/rules/data-infrastructure.md §2. Idempotent via WHERE clauses.
--
-- Routing timestamp: created_at + 65 minutes as the proxy for when owner sent the
-- manual email to Andy (~16:40 UTC vs 15:35 UTC submit).

BEGIN;

-- (1) Melanie Watson — direct INSERT into leads.submissions.
--     Idempotent via NOT EXISTS check on email + form_name (Melanie's email has no
--     other submissions in our DB today, so this is tight enough).
INSERT INTO leads.submissions (
  schema_version, submitted_at, page_url, course_id, provider_ids,
  region_scheme, funding_route,
  utm_source, utm_medium, utm_campaign, utm_content,
  fbclid, gclid, referrer,
  first_name, last_name, email, phone, la, age_band,
  employment_status, prior_level_3_or_higher, can_start_on_intake_date,
  outcome_interest, why_this_course,
  terms_accepted, marketing_opt_in,
  is_dq, dq_reason, session_id, raw_payload, archived_at
)
SELECT
  '1.0', '2026-04-21T15:35:02Z', 'https://switchable.org.uk/funded/smm-for-ecommerce-tees-valley/',
  'smm-for-ecommerce-tees-valley', ARRAY['enterprise-made-simple'],
  'tees_valley_ca', 'free_courses_for_jobs',
  'meta', 'paid', '120241514035290775', '120241683559680775',
  'IwZXh0bgNhZW0BMABhZGlkAasvLJXCiLdzcnRjBmFwcF9pZAo2NjI4NTY4Mzc5AAEePuDdLqeiqReViRo8pNOzQ35I_ZjKxuhATBcDyCnXDTms6q8Ym67W6ezywGg_aem_NZq0rM6WOdoCLR21YI6-oQ', NULL,
  'https://switchable.org.uk/funded/smm-for-ecommerce-tees-valley/?utm_source=meta&utm_medium=paid&utm_campaign=120241514035290775&utm_content=120241683559680775&utm_term=120241683559670775&fbclid=IwZXh0bgNhZW0BMABhZGlkAasvLJXCiLdzcnRjBmFwcF9pZAo2NjI4NTY4Mzc5AAEePuDdLqeiqReViRo8pNOzQ35I_ZjKxuhATBcDyCnXDTms6q8Ym67W6ezywGg_aem_NZq0rM6WOdoCLR21YI6-oQ',
  'Melanie', 'Watson', 'melkayla1982@yahoo.co.uk', '07901654323', 'stockton-on-tees', '24_plus',
  'unemployed', false, true,
  NULL, NULL,
  true, true,
  false, NULL, '7947fc72-a93d-42ef-a192-77097e4909db'::uuid,
  jsonb_build_object(
    'id', 'manual-backfill-melanie-watson-2026-04-21',
    'form_name', 'switchable-funded',
    'source', 'data-ops/005_melanie_routing_and_curl_cleanup',
    'reason', 'webhook_disabled_during_submission',
    'session_id', '7947fc72-a93d-42ef-a192-77097e4909db',
    'created_at', '2026-04-21T15:35:02Z',
    'data', jsonb_build_object(
      'schema_version', '1.0',
      'session_id', '7947fc72-a93d-42ef-a192-77097e4909db',
      'course_id', 'smm-for-ecommerce-tees-valley',
      'provider_ids', 'enterprise-made-simple',
      'region_scheme', 'tees_valley_ca',
      'funding_route', 'free_courses_for_jobs',
      'first_name', 'Melanie',
      'last_name', 'Watson',
      'email', 'melkayla1982@yahoo.co.uk',
      'phone', '07901654323',
      'postcode', 'TS21 1JF',
      'la', 'stockton-on-tees',
      'age_band', '24_plus',
      'prior_level_3', 'no',
      'employment_status', 'unemployed',
      'can_start', 'yes',
      'terms_accepted', 'on',
      'marketing_opt_in', 'on'
    )
  ),
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM leads.submissions
   WHERE email = 'melkayla1982@yahoo.co.uk'
     AND raw_payload->>'form_name' = 'switchable-funded'
);

-- (2) Route Melanie to Enterprise Made Simple (manual_email, matches Lucy's pattern).
WITH melanie AS (
  UPDATE leads.submissions
     SET primary_routed_to = 'enterprise-made-simple',
         routed_at         = created_at + interval '65 minutes',
         updated_at        = now()
   WHERE email = 'melkayla1982@yahoo.co.uk'
     AND raw_payload->>'form_name' = 'switchable-funded'
     AND primary_routed_to IS NULL
  RETURNING id, created_at + interval '65 minutes' AS routed_at
)
INSERT INTO leads.routing_log
  (submission_id, provider_id, routed_at, route_reason, delivery_method, delivery_status)
SELECT id, 'enterprise-made-simple', routed_at, 'primary', 'manual_email', 'sent'
FROM melanie
WHERE NOT EXISTS (
  SELECT 1 FROM leads.routing_log
   WHERE submission_id = melanie.id
     AND provider_id   = 'enterprise-made-simple'
);

-- (3) Delete the Session 3.3 curl test row (email curltest@switchable.careers).
--     Hard delete — never a real submission, no downstream references.
DELETE FROM leads.submissions
 WHERE email = 'curltest@switchable.careers'
   AND raw_payload->>'id' LIKE 'test-curl-post-refactor-%'
   AND is_dq = true
   AND dq_reason = 'owner_test_submission';

-- Verify
SELECT id, is_dq, dq_reason, primary_routed_to, routed_at, first_name, last_name, email,
       session_id::text, raw_payload->>'form_name' AS form_name
  FROM leads.submissions
 WHERE email IN ('melkayla1982@yahoo.co.uk', 'curltest@switchable.careers')
 ORDER BY id;

SELECT submission_id, provider_id, route_reason, delivery_method, delivery_status, routed_at
  FROM leads.routing_log
 WHERE submission_id IN (SELECT id FROM leads.submissions WHERE email = 'melkayla1982@yahoo.co.uk');

COMMIT;
