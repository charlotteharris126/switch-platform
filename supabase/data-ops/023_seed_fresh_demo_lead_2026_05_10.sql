-- Data-op 023 — seed one fresh demo lead so Charlotte can test the
--                full routing flow end-to-end (lead lands in portal +
--                routing email re-fired via /admin/leads/[id] button)
-- Date:    2026-05-10
-- Author:  Claude (platform Session 39) on Charlotte's instruction
-- Purpose: Adds one new submission routed to demo-provider-ltd with
--          a fresh routing_log + enrolment row. Mirrors the shape that
--          netlify-lead-router would produce, just bypasses the form +
--          routing logic. After this runs, the new lead appears at the
--          top of the demo provider's portal leads list.
--
--          Charlotte then clicks the violet "Test-send (demo only)"
--          card on /admin/leads/<new id> to fire the routing email
--          via Brevo and verify it lands in hello+demo@switchable.org.uk.
--
-- Side-effects: 3 rows total in production:
--   - leads.submissions (the lead)
--   - leads.routing_log (route to demo)
--   - crm.enrolments (status='open')
-- Demo data is filtered out of admin views per lib/demo.ts and
-- migration 0101 (Brevo sync), so no real-data pollution.

BEGIN;

WITH new_sub AS (
  INSERT INTO leads.submissions (
    submitted_at, source_form, schema_version,
    first_name, last_name, email, phone,
    age_band, employment_status, course_id, funding_category, funding_route,
    prior_level_3_or_higher, can_start_on_intake_date,
    preferred_intake_id, acceptable_intake_ids,
    outcome_interest, la, region,
    primary_routed_to, routed_at,
    marketing_opt_in, terms_accepted,
    is_dq, dq_reason,
    raw_payload
  ) VALUES (
    now(), 'switchable-funded-v1', '1.0',
    'Sample', 'Tester', 'sample.tester+demo@example.com', '07700900111',
    '25_34', 'unemployed', 'smm-for-ecommerce-tees-valley', 'gov', 'skills_bootcamp',
    true, true,
    'tees-valley-2026-05-26', ARRAY['tees-valley-2026-05-26']::text[],
    'career_change', 'middlesbrough', 'tees-valley',
    'demo-provider-ltd', now(),
    true, true,
    false, NULL,
    '{"source": "data-ops/023 demo seed"}'::jsonb
  )
  RETURNING id, primary_routed_to
)
INSERT INTO leads.routing_log (submission_id, provider_id, routed_at, delivery_method, delivery_status, route_reason)
SELECT id, primary_routed_to, now(), 'auto_route', 'delivered', 'demo-test-route'
FROM new_sub
RETURNING submission_id;

INSERT INTO crm.enrolments (
  submission_id, provider_id, status, status_updated_at,
  sent_to_provider_at, created_at, updated_at
)
SELECT id, 'demo-provider-ltd', 'open', now(), now(), now(), now()
FROM leads.submissions
WHERE email = 'sample.tester+demo@example.com'
ORDER BY id DESC
LIMIT 1;

-- Report new id for Charlotte
SELECT id AS new_submission_id, first_name || ' ' || last_name AS name, email
FROM leads.submissions
WHERE email = 'sample.tester+demo@example.com'
ORDER BY id DESC
LIMIT 1;

COMMIT;
