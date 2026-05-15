-- Data-ops 032 — backfill Riverside b2b_trust_line
-- Date:   2026-05-15
-- Owner:  Charlotte
-- Reason:
--   Migration 0142 added crm.providers.b2b_trust_line. The U1-employer
--   Brevo template references {{contact.B2B_PROVIDER_TRUST_LINE}};
--   without a value on Riverside's row, every employer lead's U1
--   renders a blank in that spot. Wren's canonical prose (from her
--   2026-05-15 push to platform/docs/current-handoff.md) lands here.
--
--   v1 is Riverside-only on the employer-lead route, so this is a
--   one-row backfill. Future apprenticeship providers will land via
--   Mable's /new-apprenticeship-provider skill, which writes the
--   column as part of onboarding.
--
-- Pre-condition: migration 0142 applied.

BEGIN;

-- 1. Preview the current state.
SELECT provider_id, company_name, b2b_trust_line
  FROM crm.providers
 WHERE provider_id = 'riverside-training';

-- 2. Set the canonical B2B trust line.
UPDATE crm.providers
   SET b2b_trust_line = 'They''ve been delivering apprenticeships for over 30 years, are rated Good by Ofsted, have a 98.4% pass rate and run programmes nationwide for employers including the NHS, BMW, MINI, Five Guys and Wiley.',
       updated_at     = now()
 WHERE provider_id = 'riverside-training';

-- 3. Audit row.
SELECT audit.log_system_action(
  'data_ops:032',
  'set_b2b_trust_line',
  'crm.providers',
  'riverside-training',
  jsonb_build_object('b2b_trust_line', NULL),
  jsonb_build_object('b2b_trust_line', 'set'),
  jsonb_build_object(
    'provider_id', 'riverside-training',
    'source', 'data_ops:032_riverside_b2b_trust_line_backfill_2026_05_15',
    'reason', 'Initial population of crm.providers.b2b_trust_line for Riverside, canonical prose from Wren push 2026-05-15'
  )
);

-- 4. Verification — row now non-null.
SELECT provider_id, company_name, b2b_trust_line
  FROM crm.providers
 WHERE provider_id = 'riverside-training';

COMMIT;
