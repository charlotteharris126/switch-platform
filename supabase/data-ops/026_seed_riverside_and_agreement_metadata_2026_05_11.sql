-- Data fix 026 — seed Riverside provider row + populate agreement_version
--                 + sla_*_obligations for all four pilot providers
-- Date:   2026-05-11
-- Owner:  Charlotte
-- Reason:
--   Two coupled changes:
--     A) Switchable for Business v1 launches Wed 13 May with Riverside
--        Training as the sole employer-lead provider. Need a crm.providers
--        row so the new netlify-employer-lead-router Edge Function can
--        write primary_routed_to='riverside-training' and the portal can
--        render Jane's view this week.
--     B) The new /provider/agreement page reads agreement_version +
--        sla_provider_obligations + sla_switchleads_obligations from
--        crm.providers and renders a "Your side / Our side" summary plus
--        a link to the full Notion PPA. Migration 0123 added the columns;
--        this data-ops populates them for the four pilot rows.
--
--   PPA version mapping:
--     - EMS, Courses Direct, WYK Digital signed PPA v1 (funded-only, silent
--       on VAT).
--     - Riverside signed PPA v2 (dual-route apprenticeships + VAT clause;
--       first v2 signature on record, 7 May 2026).
--
--   Notion PPA page IDs are intentionally left NULL here — Charlotte to
--   populate via /admin/providers/[id] once she's confirmed the link
--   shape (page-anchor URLs vs raw IDs).
--
-- Pre-flight:
--   - Migration 0122 applied (lead_type + employer columns on submissions)
--   - Migration 0123 applied (agreement_version + sla_*_obligations on
--     crm.providers)
--   - Confirm no existing row at provider_id='riverside-training':
--       SELECT * FROM crm.providers WHERE provider_id = 'riverside-training';
--
-- Run plan:
--   Step 1: insert Riverside row (Block A).
--   Step 2: update v1 providers' agreement metadata (Block B).
--   Step 3: update Riverside's agreement metadata (Block C).
--   Step 4: verify row count + portal_enabled state on Riverside.

BEGIN;

-- ----------------------------------------------------------------------------
-- BLOCK A — seed Riverside Training provider row
-- ----------------------------------------------------------------------------
-- Riverside Training Limited (Hereford, UKPRN 10005488). v1 pilot signed
-- 7 May 2026 by Jane Preston, Director. Employer Lead route only.
-- Starting standard: Project Management Level 4.
-- portal_enabled=true so Charlotte can invite Jane this week (per the
-- "Riverside portal launching this week" instruction).
INSERT INTO crm.providers (
  provider_id, company_name, contact_name, contact_email,
  pilot_status, pricing_model, billing_model, per_enrolment_fee,
  free_enrolments_remaining, active, portal_enabled,
  agreement_signed_at, agreement_version,
  funding_types, regions,
  trust_line, notes
) VALUES (
  'riverside-training',
  'Riverside Training Limited',
  'Jane Preston',
  -- Replace with Jane's confirmed inbox after Nell confirms.
  'jane.preston@riversidetraining.example',
  'pilot',
  'per_enrolment_flat',           -- £400 flat per Employer Signed
  'retrospective_per_enrolment',
  400.00,                          -- PPA v2 clause 3.4b
  1,                               -- First Employer Signed free (clause 3.4c)
  true,
  true,
  TIMESTAMPTZ '2026-05-07 00:00:00+00',
  'v2',
  ARRAY['apprenticeship']::text[],
  ARRAY['UK']::text[],             -- Riverside is UK-wide for apprenticeships
  'Apprenticeship specialist, UKPRN 10005488',
  'PPA v2 (dual-route) signed 7 May 2026. Employer Lead route only for v1. Starting standard: Project Management Level 4. Pricing: £400 per Employer Signed, first one free, 60-day Presumed clock.'
)
ON CONFLICT (provider_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- BLOCK B — PPA v1 metadata (EMS, Courses Direct, WYK Digital)
-- ----------------------------------------------------------------------------
UPDATE crm.providers
SET
  agreement_version = 'v1',
  sla_provider_obligations = ARRAY[
    'Action every routed lead within 24 hours of receipt',
    'Update Status column on your sheet (or portal) when an enrolment outcome is confirmed',
    'Pay invoice within 14 days of receipt (monthly billing cadence)',
    'Maintain accurate course intake dates so leads route to the right cohort'
  ]::text[],
  sla_switchleads_obligations = ARRAY[
    'Route only learners who match your eligibility criteria',
    'Pre-screen each lead for funding eligibility and intent before routing',
    'Bill only on confirmed enrolments (or presumed-enrolled after 14-day no-response)',
    'Notify you of every routed lead within minutes of submission'
  ]::text[]
WHERE provider_id IN ('enterprise-made-simple', 'courses-direct', 'wyk-digital')
  AND agreement_version IS NULL;

-- ----------------------------------------------------------------------------
-- BLOCK C — PPA v2 metadata (Riverside)
-- ----------------------------------------------------------------------------
UPDATE crm.providers
SET
  agreement_version = 'v2',
  sla_provider_obligations = ARRAY[
    'Action every routed employer lead within 24 hours of receipt',
    'Update Status column on your sheet (or portal) when an Employer Signed outcome is confirmed',
    'Pay invoice within 14 days of receipt (monthly billing cadence)',
    'Honour the £400 flat fee per Employer Signed (no levy banding)'
  ]::text[],
  sla_switchleads_obligations = ARRAY[
    'Source qualified employer leads (HRDs, L&D, training managers, owner-MDs at 50-1000 staff)',
    'Pre-screen each lead for sector fit, levy status, and apprenticeship interest',
    'Bill only on confirmed Employer Signed (or Presumed Employer Signed after 60 days)',
    'Notify you of every routed employer lead within minutes of submission'
  ]::text[]
WHERE provider_id = 'riverside-training';

COMMIT;

-- ----------------------------------------------------------------------------
-- Post-flight verification
-- ----------------------------------------------------------------------------
-- SELECT provider_id, agreement_version,
--        array_length(sla_provider_obligations, 1)     AS provider_bullets,
--        array_length(sla_switchleads_obligations, 1)  AS our_bullets,
--        portal_enabled
-- FROM crm.providers
-- WHERE archived_at IS NULL
-- ORDER BY provider_id;
--
-- Expect 5 rows: 4 pilot + demo. All four pilot rows agreement_version set.
-- Riverside portal_enabled=true.
