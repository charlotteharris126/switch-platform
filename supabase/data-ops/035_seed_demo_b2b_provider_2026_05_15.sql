-- Data-ops 035 — seed Demo B2B provider for portal screen recording
-- Date:   2026-05-15
-- Owner:  Charlotte
-- Reason:
--   Charlotte wants a clean B2B provider account for screen recording
--   a real first-login experience: welcome deck → SLA tick → portal.
--   The seed provider needs to mirror Riverside's shape so the
--   employer-deck variant of /provider/welcome renders identically to
--   what real apprenticeship providers see.
--
--   This script seeds ONLY the crm.providers row. The matching
--   crm.provider_users row is then created via the existing admin UI
--   "Invite" button on /admin/providers/demo-b2b so the auth user
--   provisioning runs through the same flow real providers use.
--
--   Per Charlotte 2026-05-15, demo signin email is
--   demo+b2b@switchable.org.uk (delivers via plus-alias).
--
-- Pre-conditions:
--   - Migration 0142 applied (b2b_trust_line column)
--   - Migration 0143 applied (provider RLS excludes is_dq)
--   - Migration 0144 applied (per-user SLA columns on provider_users)
--
-- Rollback: DELETE FROM crm.providers WHERE provider_id = 'demo-b2b' AND is_demo = true;

BEGIN;

INSERT INTO crm.providers (
  provider_id,
  company_name,
  contact_name,
  contact_email,
  is_demo,
  pricing_model,
  per_enrolment_fee,
  agreement_version,
  funding_types,
  portal_enabled,
  sla_first_attempt_hours,
  sla_attempts_required,
  sla_attempt_window_days,
  sla_stale_attempt_hours,
  sla_presumed_flip_days,
  b2b_trust_line,
  trust_line,
  pilot_status
) VALUES (
  'demo-b2b',
  'Demo Apprenticeship Provider',
  'Demo User',
  'demo+b2b@switchable.org.uk',
  true,
  'per_enrolment_flat',
  400,
  'v2',
  ARRAY['apprenticeship']::text[],
  true,
  24,
  3,
  7,
  36,
  60,
  'Demo B2B trust line. Used so the welcome-deck employer variant renders cleanly when Charlotte screen-records the first-login flow.',
  'Demo trust line for any legacy reads on this column.',
  'pilot'
);

-- Audit row.
SELECT audit.log_system_action(
  'data_ops:035',
  'seed_demo_provider',
  'crm.providers',
  'demo-b2b',
  NULL,
  jsonb_build_object('provider_id', 'demo-b2b', 'is_demo', true, 'company_name', 'Demo Apprenticeship Provider'),
  jsonb_build_object(
    'source', 'data_ops:035_seed_demo_b2b_provider_2026_05_15',
    'reason', 'Demo B2B account for screen-recording the new-user portal experience (welcome → SLA → leads)'
  )
);

-- Verification — row inserted, employer-shape ready.
SELECT provider_id, company_name, contact_email, funding_types, agreement_version,
       portal_enabled, is_demo, b2b_trust_line IS NOT NULL AS trust_line_set
  FROM crm.providers
 WHERE provider_id = 'demo-b2b';

COMMIT;
