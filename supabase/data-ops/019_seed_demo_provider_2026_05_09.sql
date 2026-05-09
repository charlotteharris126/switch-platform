-- Data-ops 019 — Seed demo provider for portal MVP dogfooding
-- Date:   2026-05-09
-- Author: Claude (platform Session 37 / Sasha) on Charlotte's instruction
-- Reason: Provider portal MVP build (P2-P4) needs a sandbox provider with
--         realistic-looking data spanning every status in the new taxonomy
--         (migration 0091). Charlotte dogfoods auth + invite + outcome
--         marking + admin views against this fixture rather than touching
--         real provider data. is_demo=true gates the rows out of every
--         dashboard view, billing calc, and reconcile cron (per the
--         provider-portal-mvp-scoping doc); migration 0101 covers Brevo.
--
--         Twelve leads spanning the nine statuses (open ×3 to cover ages,
--         attempt_1/2/3, enrolment_meeting_booked, enrolled ×2, lost,
--         cannot_reach, presumed_enrolled). Routed dates back-dated to give
--         the admin "days since routed" / age-based UI realistic spread.
--
--         Emails use the @demo.example.com domain — invalid TLD pattern,
--         RFC 6761 reserved for examples and documentation, will never hit
--         a real inbox even if Brevo somehow received them. Belt-and-braces
--         alongside the migration 0101 filter.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: insert 1 crm.providers row + 12 leads.submissions rows + 12
--      leads.routing_log rows + 12 crm.enrolments rows. All flagged via the
--      provider's is_demo=true so they are filtered out of every consumer.
--   2. Readers: admin dashboard (visible until is_demo filtering ships in
--      the Phase 4 admin views), portal pages (visible — the whole point).
--   3. Writers: none post-seed.
--   4. Schema version: not affected. raw_payload uses schema_version='1.0'.
--   5. Data migration: none.
--   6. Role/policy: existing admin RLS sees all rows, including demo. RLS
--      from 0096 restricts portal-side access to the demo's own provider_users
--      rows once a user is enrolled (P2 work).
--   7. Rollback: DELETE from the four tables WHERE provider_id =
--      'demo-provider-ltd'. Snippet at the bottom of this file.
--   8. Sign-off: owner (this session, 2026-05-09).
-- Related: migration 0093 (is_demo column), 0091 (status taxonomy),
--          0094 (provider_users — seeded post-invite, not here),
--          0101 (Brevo sync filter), provider-portal-mvp-scoping.md.

BEGIN;

-- ─── 1. Provider row ──────────────────────────────────────────────────────

INSERT INTO crm.providers (
  provider_id,
  company_name,
  contact_name,
  contact_email,
  pilot_status,
  pricing_model,
  per_enrolment_fee,
  free_enrolments_remaining,
  active,
  onboarded_at,
  agreement_signed_at,
  funding_types,
  regions,
  trust_line,
  notes,
  auto_route_enabled,
  billing_model,
  is_demo,
  portal_enabled
) VALUES (
  'demo-provider-ltd',
  'Demo Provider Ltd',
  'Demo Admin',
  'hello+demo@switchable.org.uk',
  'pilot',
  'per_enrolment_flat',
  150.00,
  3,
  true,
  '2026-05-01 00:00:00+00',
  '2026-05-01 00:00:00+00',
  ARRAY['funded','self_funded']::TEXT[],
  ARRAY['London','Tees Valley']::TEXT[],
  'Independent training provider since 2018',
  'Fixture provider for portal MVP dogfooding. is_demo=true so all dashboard views / billing calcs / reconcile crons / Brevo sync filter it out. Seeded via data-ops/019 (2026-05-09).',
  false,
  'retrospective_per_enrolment',
  true,
  true
);

-- ─── 2. Leads — 12 submissions spanning the new status taxonomy ───────────

-- Helper: every submission has primary_routed_to='demo-provider-ltd' and
-- routed_at backdated to give the admin/portal age-based UI realistic spread.
-- raw_payload is a minimal stub matching the funded-funnel shape; nothing
-- downstream re-parses it, but keeping schema_version='1.0' is the convention.

-- 1) open, routed 3 days ago, funded, Tees Valley
INSERT INTO leads.submissions (
  schema_version, submitted_at, page_url, course_id, provider_ids, region_scheme, funding_route,
  utm_source, utm_medium, utm_campaign,
  first_name, last_name, email, phone, la, age_band, employment_status,
  prior_level_3_or_higher, can_start_on_intake_date, outcome_interest,
  terms_accepted, marketing_opt_in, is_dq, primary_routed_to, routed_at, raw_payload,
  funding_category, referral_code
) VALUES (
  '1.0', now() - INTERVAL '3 days', 'https://switchable.org.uk/courses/social-media-marketing/', 'smm-for-ecommerce-tees-valley',
  ARRAY['demo-provider-ltd']::TEXT[], 'tees-valley', 'fcfj',
  'demo-fb', 'paid-social', 'demo-funded-may',
  'Aisha', 'Patel', 'aisha.patel@demo.example.com', '07700900001', 'middlesbrough', '25-34', 'unemployed',
  false, true, 'change_career',
  true, true, false, 'demo-provider-ltd', now() - INTERVAL '3 days',
  '{"form_name":"switchable-funded-v1","note":"demo seed"}'::jsonb,
  'gov', 'demo-019-001'
);

-- 2) open, routed 16 days ago (would be in auto-flip cohort if cron armed)
INSERT INTO leads.submissions (
  schema_version, submitted_at, page_url, course_id, provider_ids, region_scheme, funding_route,
  utm_source, utm_medium, utm_campaign,
  first_name, last_name, email, phone, la, age_band, employment_status,
  prior_level_3_or_higher, can_start_on_intake_date, outcome_interest,
  terms_accepted, marketing_opt_in, is_dq, primary_routed_to, routed_at, raw_payload,
  funding_category, referral_code
) VALUES (
  '1.0', now() - INTERVAL '16 days', 'https://switchable.org.uk/courses/counselling-skills/', 'counselling-skills-tees-valley',
  ARRAY['demo-provider-ltd']::TEXT[], 'tees-valley', 'fcfj',
  'demo-google', 'cpc', 'demo-funded-april',
  'Marcus', 'Okafor', 'marcus.okafor@demo.example.com', '07700900002', 'redcar-and-cleveland', '35-44', 'employed_part_time',
  false, true, 'progress_in_role',
  true, false, false, 'demo-provider-ltd', now() - INTERVAL '16 days',
  '{"form_name":"switchable-funded-v1","note":"demo seed"}'::jsonb,
  'gov', 'demo-019-002'
);

-- 3) open, routed 7 days ago, self-funded
INSERT INTO leads.submissions (
  schema_version, submitted_at, page_url, course_id, provider_ids, funding_route,
  first_name, last_name, email, phone, age_band, employment_status,
  outcome_interest, budget,
  terms_accepted, marketing_opt_in, is_dq, primary_routed_to, routed_at, raw_payload,
  funding_category, referral_code
) VALUES (
  '1.0', now() - INTERVAL '7 days', 'https://switchable.org.uk/self-funded/', NULL,
  ARRAY['demo-provider-ltd']::TEXT[], 'self_funded',
  'Priya', 'Sharma', 'priya.sharma@demo.example.com', '07700900003', '25-34', 'employed_full_time',
  'change_career', '500-1000',
  true, true, false, 'demo-provider-ltd', now() - INTERVAL '7 days',
  '{"form_name":"switchable-self-funded-v1","note":"demo seed"}'::jsonb,
  'self', 'demo-019-003'
);

-- 4) attempt_1_no_answer, routed 2 days ago
INSERT INTO leads.submissions (
  schema_version, submitted_at, page_url, course_id, provider_ids, region_scheme, funding_route,
  first_name, last_name, email, phone, la, age_band, employment_status,
  outcome_interest,
  terms_accepted, marketing_opt_in, is_dq, primary_routed_to, routed_at, raw_payload,
  funding_category, referral_code
) VALUES (
  '1.0', now() - INTERVAL '2 days', 'https://switchable.org.uk/courses/social-media-marketing/', 'smm-for-ecommerce-tees-valley',
  ARRAY['demo-provider-ltd']::TEXT[], 'tees-valley', 'fcfj',
  'James', 'Wilson', 'james.wilson@demo.example.com', '07700900004', 'stockton-on-tees', '19-24', 'unemployed',
  'find_work',
  true, false, false, 'demo-provider-ltd', now() - INTERVAL '2 days',
  '{"form_name":"switchable-funded-v1","note":"demo seed"}'::jsonb,
  'gov', 'demo-019-004'
);

-- 5) attempt_2_no_answer, routed 5 days ago
INSERT INTO leads.submissions (
  schema_version, submitted_at, page_url, course_id, provider_ids, region_scheme, funding_route,
  first_name, last_name, email, phone, la, age_band, employment_status,
  outcome_interest,
  terms_accepted, marketing_opt_in, is_dq, primary_routed_to, routed_at, raw_payload,
  funding_category, referral_code
) VALUES (
  '1.0', now() - INTERVAL '5 days', 'https://switchable.org.uk/courses/counselling-skills/', 'counselling-skills-tees-valley',
  ARRAY['demo-provider-ltd']::TEXT[], 'tees-valley', 'fcfj',
  'Sofia', 'Romano', 'sofia.romano@demo.example.com', '07700900005', 'hartlepool', '35-44', 'unemployed',
  'change_career',
  true, true, false, 'demo-provider-ltd', now() - INTERVAL '5 days',
  '{"form_name":"switchable-funded-v1","note":"demo seed"}'::jsonb,
  'gov', 'demo-019-005'
);

-- 6) attempt_3_no_answer, routed 8 days ago
INSERT INTO leads.submissions (
  schema_version, submitted_at, page_url, course_id, provider_ids, region_scheme, funding_route,
  first_name, last_name, email, phone, la, age_band, employment_status,
  outcome_interest,
  terms_accepted, marketing_opt_in, is_dq, primary_routed_to, routed_at, raw_payload,
  funding_category, referral_code
) VALUES (
  '1.0', now() - INTERVAL '8 days', 'https://switchable.org.uk/courses/social-media-marketing/', 'smm-for-ecommerce-tees-valley',
  ARRAY['demo-provider-ltd']::TEXT[], 'tees-valley', 'fcfj',
  'Liam', 'OConnor', 'liam.oconnor@demo.example.com', '07700900006', 'darlington', '25-34', 'employed_part_time',
  'progress_in_role',
  true, false, false, 'demo-provider-ltd', now() - INTERVAL '8 days',
  '{"form_name":"switchable-funded-v1","note":"demo seed"}'::jsonb,
  'gov', 'demo-019-006'
);

-- 7) enrolment_meeting_booked, routed 6 days ago
INSERT INTO leads.submissions (
  schema_version, submitted_at, page_url, course_id, provider_ids, region_scheme, funding_route,
  first_name, last_name, email, phone, la, age_band, employment_status,
  outcome_interest,
  terms_accepted, marketing_opt_in, is_dq, primary_routed_to, routed_at, raw_payload,
  funding_category, referral_code
) VALUES (
  '1.0', now() - INTERVAL '6 days', 'https://switchable.org.uk/courses/counselling-skills/', 'counselling-skills-tees-valley',
  ARRAY['demo-provider-ltd']::TEXT[], 'tees-valley', 'fcfj',
  'Naomi', 'Bryant', 'naomi.bryant@demo.example.com', '07700900007', 'middlesbrough', '45-54', 'employed_full_time',
  'change_career',
  true, true, false, 'demo-provider-ltd', now() - INTERVAL '6 days',
  '{"form_name":"switchable-funded-v1","note":"demo seed"}'::jsonb,
  'gov', 'demo-019-007'
);

-- 8) enrolled, routed 10 days ago
INSERT INTO leads.submissions (
  schema_version, submitted_at, page_url, course_id, provider_ids, region_scheme, funding_route,
  first_name, last_name, email, phone, la, age_band, employment_status,
  outcome_interest,
  terms_accepted, marketing_opt_in, is_dq, primary_routed_to, routed_at, raw_payload,
  funding_category, referral_code
) VALUES (
  '1.0', now() - INTERVAL '10 days', 'https://switchable.org.uk/courses/social-media-marketing/', 'smm-for-ecommerce-tees-valley',
  ARRAY['demo-provider-ltd']::TEXT[], 'tees-valley', 'fcfj',
  'Hannah', 'Choudhury', 'hannah.choudhury@demo.example.com', '07700900008', 'redcar-and-cleveland', '25-34', 'unemployed',
  'find_work',
  true, true, false, 'demo-provider-ltd', now() - INTERVAL '10 days',
  '{"form_name":"switchable-funded-v1","note":"demo seed"}'::jsonb,
  'gov', 'demo-019-008'
);

-- 9) enrolled, routed 14 days ago
INSERT INTO leads.submissions (
  schema_version, submitted_at, page_url, course_id, provider_ids, region_scheme, funding_route,
  first_name, last_name, email, phone, la, age_band, employment_status,
  outcome_interest,
  terms_accepted, marketing_opt_in, is_dq, primary_routed_to, routed_at, raw_payload,
  funding_category, referral_code
) VALUES (
  '1.0', now() - INTERVAL '14 days', 'https://switchable.org.uk/courses/counselling-skills/', 'counselling-skills-tees-valley',
  ARRAY['demo-provider-ltd']::TEXT[], 'tees-valley', 'fcfj',
  'Daniel', 'Pereira', 'daniel.pereira@demo.example.com', '07700900009', 'stockton-on-tees', '35-44', 'employed_part_time',
  'progress_in_role',
  true, false, false, 'demo-provider-ltd', now() - INTERVAL '14 days',
  '{"form_name":"switchable-funded-v1","note":"demo seed"}'::jsonb,
  'gov', 'demo-019-009'
);

-- 10) lost, routed 12 days ago, with lost_reason
INSERT INTO leads.submissions (
  schema_version, submitted_at, page_url, course_id, provider_ids, region_scheme, funding_route,
  first_name, last_name, email, phone, la, age_band, employment_status,
  outcome_interest,
  terms_accepted, marketing_opt_in, is_dq, primary_routed_to, routed_at, raw_payload,
  funding_category, referral_code
) VALUES (
  '1.0', now() - INTERVAL '12 days', 'https://switchable.org.uk/courses/social-media-marketing/', 'smm-for-ecommerce-tees-valley',
  ARRAY['demo-provider-ltd']::TEXT[], 'tees-valley', 'fcfj',
  'Olivia', 'Marsh', 'olivia.marsh@demo.example.com', '07700900010', 'hartlepool', '19-24', 'unemployed',
  'find_work',
  true, true, false, 'demo-provider-ltd', now() - INTERVAL '12 days',
  '{"form_name":"switchable-funded-v1","note":"demo seed"}'::jsonb,
  'gov', 'demo-019-010'
);

-- 11) cannot_reach, routed 15 days ago
INSERT INTO leads.submissions (
  schema_version, submitted_at, page_url, course_id, provider_ids, region_scheme, funding_route,
  first_name, last_name, email, phone, la, age_band, employment_status,
  outcome_interest,
  terms_accepted, marketing_opt_in, is_dq, primary_routed_to, routed_at, raw_payload,
  funding_category, referral_code
) VALUES (
  '1.0', now() - INTERVAL '15 days', 'https://switchable.org.uk/courses/counselling-skills/', 'counselling-skills-tees-valley',
  ARRAY['demo-provider-ltd']::TEXT[], 'tees-valley', 'fcfj',
  'Femi', 'Adebayo', 'femi.adebayo@demo.example.com', '07700900011', 'darlington', '45-54', 'employed_full_time',
  'change_career',
  true, false, false, 'demo-provider-ltd', now() - INTERVAL '15 days',
  '{"form_name":"switchable-funded-v1","note":"demo seed"}'::jsonb,
  'gov', 'demo-019-011'
);

-- 12) presumed_enrolled, routed 17 days ago (system-set state)
INSERT INTO leads.submissions (
  schema_version, submitted_at, page_url, course_id, provider_ids, region_scheme, funding_route,
  first_name, last_name, email, phone, la, age_band, employment_status,
  outcome_interest,
  terms_accepted, marketing_opt_in, is_dq, primary_routed_to, routed_at, raw_payload,
  funding_category, referral_code
) VALUES (
  '1.0', now() - INTERVAL '17 days', 'https://switchable.org.uk/courses/social-media-marketing/', 'smm-for-ecommerce-tees-valley',
  ARRAY['demo-provider-ltd']::TEXT[], 'tees-valley', 'fcfj',
  'Yasmin', 'Khan', 'yasmin.khan@demo.example.com', '07700900012', 'middlesbrough', '25-34', 'unemployed',
  'change_career',
  true, true, false, 'demo-provider-ltd', now() - INTERVAL '17 days',
  '{"form_name":"switchable-funded-v1","note":"demo seed"}'::jsonb,
  'gov', 'demo-019-012'
);

-- ─── 3. Routing log entries (one per lead) ────────────────────────────────

INSERT INTO leads.routing_log (
  submission_id, provider_id, routed_at, route_reason, delivery_method, delivery_status, delivered_at
)
SELECT
  s.id,
  'demo-provider-ltd',
  s.routed_at,
  'demo_seed',
  'demo_seed',
  'delivered',
  s.routed_at + INTERVAL '5 minutes'
FROM leads.submissions s
WHERE s.referral_code LIKE 'demo-019-%';

-- ─── 4. Enrolment rows with status spread ─────────────────────────────────

-- Helper inline: pull (submission_id, routing_log_id) pairs into the INSERT
WITH demo_pairs AS (
  SELECT
    s.id              AS submission_id,
    rl.id             AS routing_log_id,
    s.referral_code,
    s.routed_at
    FROM leads.submissions s
    JOIN leads.routing_log rl ON rl.submission_id = s.id AND rl.provider_id = 'demo-provider-ltd'
   WHERE s.referral_code LIKE 'demo-019-%'
)
INSERT INTO crm.enrolments (
  submission_id, routing_log_id, provider_id, status, sent_to_provider_at, status_updated_at,
  presumed_deadline_at, dispute_deadline_at, lost_reason, notes
)
SELECT
  p.submission_id,
  p.routing_log_id,
  'demo-provider-ltd',
  CASE p.referral_code
    WHEN 'demo-019-001' THEN 'open'
    WHEN 'demo-019-002' THEN 'open'
    WHEN 'demo-019-003' THEN 'open'
    WHEN 'demo-019-004' THEN 'attempt_1_no_answer'
    WHEN 'demo-019-005' THEN 'attempt_2_no_answer'
    WHEN 'demo-019-006' THEN 'attempt_3_no_answer'
    WHEN 'demo-019-007' THEN 'enrolment_meeting_booked'
    WHEN 'demo-019-008' THEN 'enrolled'
    WHEN 'demo-019-009' THEN 'enrolled'
    WHEN 'demo-019-010' THEN 'lost'
    WHEN 'demo-019-011' THEN 'cannot_reach'
    WHEN 'demo-019-012' THEN 'presumed_enrolled'
  END,
  p.routed_at,
  -- status_updated_at: random spread between routed_at and now to simulate
  -- providers acting on leads at varying speeds
  CASE p.referral_code
    WHEN 'demo-019-001' THEN p.routed_at
    WHEN 'demo-019-002' THEN p.routed_at
    WHEN 'demo-019-003' THEN p.routed_at
    WHEN 'demo-019-004' THEN p.routed_at + INTERVAL '1 day'
    WHEN 'demo-019-005' THEN p.routed_at + INTERVAL '3 days'
    WHEN 'demo-019-006' THEN p.routed_at + INTERVAL '5 days'
    WHEN 'demo-019-007' THEN p.routed_at + INTERVAL '4 days'
    WHEN 'demo-019-008' THEN p.routed_at + INTERVAL '7 days'
    WHEN 'demo-019-009' THEN p.routed_at + INTERVAL '10 days'
    WHEN 'demo-019-010' THEN p.routed_at + INTERVAL '8 days'
    WHEN 'demo-019-011' THEN p.routed_at + INTERVAL '11 days'
    WHEN 'demo-019-012' THEN p.routed_at + INTERVAL '14 days'
  END,
  -- presumed_deadline_at: only for presumed_enrolled (already past) and a
  -- couple of pending opens to test UI countdown rendering
  CASE p.referral_code
    WHEN 'demo-019-002' THEN p.routed_at + INTERVAL '14 days'
    WHEN 'demo-019-012' THEN p.routed_at + INTERVAL '14 days'
    ELSE NULL
  END,
  -- dispute_deadline_at: only for presumed_enrolled (7 days after deadline)
  CASE p.referral_code
    WHEN 'demo-019-012' THEN p.routed_at + INTERVAL '21 days'
    ELSE NULL
  END,
  -- lost_reason for the lost row
  CASE p.referral_code
    WHEN 'demo-019-010' THEN 'not_interested'
    ELSE NULL
  END,
  -- notes field carries demo provenance
  'Demo seed via data-ops/019 (2026-05-09)'
FROM demo_pairs p;

-- ─── 5. Single audit log entry summarising the seed ───────────────────────

DO $$
BEGIN
  PERFORM audit.log_system_action(
    p_actor        := 'system:manual:charlotte',
    p_action       := 'demo_provider_seed',
    p_target_table := 'crm.providers',
    p_target_id    := 'demo-provider-ltd',
    p_before       := NULL,
    p_after        := jsonb_build_object(
      'provider_id', 'demo-provider-ltd',
      'is_demo', true,
      'portal_enabled', true,
      'submissions_seeded', 12
    ),
    p_context      := jsonb_build_object(
      'reason', 'Provider portal MVP P2-P4 dogfooding fixture',
      'data_ops_script', '019_seed_demo_provider_2026_05_09'
    )
  );
END $$;

-- ─── Verification ─────────────────────────────────────────────────────────

SELECT
  e.submission_id,
  s.first_name || ' ' || s.last_name AS name,
  e.status,
  e.lost_reason,
  AGE(now(), s.routed_at) AS days_since_routed
  FROM crm.enrolments e
  JOIN leads.submissions s ON s.id = e.submission_id
 WHERE e.provider_id = 'demo-provider-ltd'
 ORDER BY s.routed_at DESC;

-- Confirm Brevo trigger filter held: no pg_net rows fired for demo IDs.
SELECT COUNT(*) AS pgnet_rows_for_demo_in_last_minute
  FROM net._http_response
 WHERE created > now() - INTERVAL '1 minute'
   AND content::text LIKE '%demo-019-%';

COMMIT;

-- ─── Rollback snippet (run only if backing the seed out) ──────────────────
-- BEGIN;
-- DELETE FROM crm.enrolments  WHERE provider_id = 'demo-provider-ltd';
-- DELETE FROM leads.routing_log WHERE provider_id = 'demo-provider-ltd';
-- DELETE FROM leads.submissions WHERE primary_routed_to = 'demo-provider-ltd';
-- DELETE FROM crm.providers   WHERE provider_id = 'demo-provider-ltd';
-- COMMIT;
