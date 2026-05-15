-- Data-ops 036 — seed Demo B2C provider for portal screen recording
-- Date:   2026-05-15
-- Owner:  Charlotte
-- Reason:
--   Companion to data-ops 035 (demo-b2b). Charlotte wants to screen-
--   record the new-user portal experience for BOTH provider shapes:
--   apprenticeship (demo-b2b, v2 agreement, employer deck) AND
--   learner-funded (demo-b2c, v1 agreement, learner deck). The
--   welcome deck branches off funding_types so this row's value
--   drives which slide deck the demo signin sees.
--
--   Mirrors the EMS / WYK shape: gov funding, PPA v1, 14-day
--   presumed-enrolment clock, £150 per funded enrolment, free-three
--   intro period.
--
--   Provider_user row gets created via the existing admin "Invite"
--   button on /admin/providers/demo-b2c against
--   demo+b2c@switchable.org.uk.
--
-- Pre-conditions:
--   - Migration 0142 applied (b2b_trust_line column — unused on this
--     row but present)
--   - Migration 0143 applied (provider RLS excludes is_dq)
--   - Migration 0144 applied (per-user SLA columns)
--
-- Rollback: DELETE FROM crm.providers WHERE provider_id = 'demo-b2c' AND is_demo = true;

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
  trust_line,
  pilot_status
) VALUES (
  'demo-b2c',
  'Demo Funded Provider',
  'Demo User',
  'demo+b2c@switchable.org.uk',
  true,
  'per_enrolment_flat',
  150,
  'v1',
  ARRAY['gov']::text[],
  true,
  24,
  3,
  7,
  36,
  14,
  'Demo trust line. Used so the welcome-deck learner variant + funded U1 templates render cleanly when Charlotte screen-records the first-login flow.',
  'pilot'
);

-- Audit row.
SELECT audit.log_system_action(
  'data_ops:036',
  'seed_demo_provider',
  'crm.providers',
  'demo-b2c',
  NULL,
  jsonb_build_object('provider_id', 'demo-b2c', 'is_demo', true, 'company_name', 'Demo Funded Provider'),
  jsonb_build_object(
    'source', 'data_ops:036_seed_demo_b2c_provider_2026_05_15',
    'reason', 'Demo B2C account for screen-recording the new-user portal experience on the learner-funded variant (welcome learner deck → SLA → leads)'
  )
);

-- Verification.
SELECT provider_id, company_name, contact_email, funding_types, agreement_version,
       portal_enabled, is_demo, sla_presumed_flip_days
  FROM crm.providers
 WHERE provider_id = 'demo-b2c';

COMMIT;
