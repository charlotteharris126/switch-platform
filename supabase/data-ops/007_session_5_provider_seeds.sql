-- data-ops 007 - Session 5 provider seeds: WYK Digital INSERT, Courses Direct
--                 + WYK Digital sheet/webhook/cc_emails UPDATEs
-- Date: 2026-04-21 (Session 5)
-- Author: Claude (Session 5) with owner review
-- Reason:
--   1. WYK Digital signed 2026-04-21 as the third pilot provider. Not yet
--      in crm.providers - routing will fail until the row exists.
--   2. Courses Direct received Ranjit-CC decision (memory/
--      project_courses_direct_routing_followup.md). cc_emails column (added
--      by migration 0012) lets routing-confirm CC him automatically.
--   3. Both Courses Direct and WYK Digital need sheet_id + sheet_webhook_url
--      populated once owner creates their Google Sheets + deploys Apps Script
--      v2. Placeholders below - owner replaces the three PASTE_* tokens with
--      real values from the Apps Script deployments.
--
-- Related:
--   - platform/supabase/migrations/0011_add_self_funded_canonical_cols.sql
--   - platform/supabase/migrations/0012_add_providers_cc_emails.sql
--   - platform/apps-scripts/provider-sheet-appender-v2.gs
--   - platform/docs/provider-onboarding-playbook.md (sheet setup steps)
--   - accounts-legal/changelog.md 2026-04-21 (WYK Digital signing)
--
-- Pattern: data-only seed. Safe to re-run - INSERT uses ON CONFLICT DO
-- NOTHING; UPDATEs are idempotent against the same values.
--
-- Run as owner (service role) via Supabase SQL editor, AFTER migrations 0011
-- and 0012 have applied, AFTER owner has created the two Google Sheets and
-- deployed Apps Script v2 on each. Before running: paste real values into
-- the three <PASTE_*> placeholders in Part 2 and Part 3.

-- =============================================================================
-- Part 1 - INSERT WYK Digital (idempotent)
-- =============================================================================

INSERT INTO crm.providers (
  provider_id,
  company_name,
  contact_name,
  contact_email,
  contact_phone,
  pilot_status,
  pricing_model,
  per_enrolment_fee,
  percent_rate,
  min_fee,
  max_fee,
  free_enrolments_remaining,
  active,
  onboarded_at,
  agreement_signed_at,
  notes,
  cc_emails
) VALUES (
  'wyk-digital',
  'WYK Digital',
  'Heena Uppal',
  'heena@wykdigital.com', -- confirmed by owner 2026-04-21
  NULL,
  'pilot',
  'per_enrolment_flat',
  150.00,
  NULL,
  NULL,
  NULL,
  3,
  true,
  '2026-04-21 00:00:00+00',
  '2026-04-21 00:00:00+00',
  $$WYK Group Limited trading as WYK Digital. Third formally signed pilot provider, signed 21 April 2026 against amended clause 6.5 (monthly invoicing). Fully funded delivery via LIFT - a Camden/Hackney/Islington tri-borough funded programme. First funded course on pilot: LIFT Digital Marketing Futures. Cohort starts 27 April 2026. 3-borough residency gate enforced site-side on the landing form (postcode + residency checkbox). Lead window held open until Fri 24 April per Heena. Target 10-15 enrolments across 3 months. Source: accounts-legal/changelog.md 21 April 2026 entry.$$,
  '{}'
)
ON CONFLICT (provider_id) DO NOTHING;

-- =============================================================================
-- Part 2 - UPDATE Courses Direct (sheet + webhook + cc_emails)
-- =============================================================================
-- After creating Courses Direct's sheet and deploying Apps Script v2,
-- replace <PASTE_CD_SHEET_ID> and <PASTE_CD_WEBHOOK_URL> with real values.

-- UPDATE crm.providers
--    SET sheet_id          = '<PASTE_CD_SHEET_ID>',
--        sheet_webhook_url = '<PASTE_CD_WEBHOOK_URL>',
--        cc_emails         = ARRAY['ranjit@courses-direct.co.uk'],
--        updated_at        = now()
--  WHERE provider_id = 'courses-direct';

-- =============================================================================
-- Part 3 - UPDATE WYK Digital (sheet + webhook)  [APPLIED 2026-04-21 evening]
-- =============================================================================
-- Applied inline during Session 5 deploy with values captured after owner
-- created the sheet and deployed Apps Script v2. cc_emails stays '{}' -
-- no co-recipient requested by Heena at signing.

-- UPDATE crm.providers
--    SET sheet_id          = '1VnRWpLyujEZidZ6PrWuQEvjFtiHmzYvohR-rHyKex0E',
--        sheet_webhook_url = 'https://script.google.com/macros/s/AKfycby1H_XPM6eP--CdW5PKVgebsiGCHpFtTe9EK5oslfpueU5fo4hK4VROHTjqUXUwsZ-I/exec',
--        updated_at        = now()
--  WHERE provider_id = 'wyk-digital';

-- =============================================================================
-- Verification (run after Parts 1-3 applied)
-- =============================================================================

-- SELECT provider_id,
--        company_name,
--        contact_email,
--        pilot_status,
--        sheet_id IS NOT NULL       AS has_sheet_id,
--        sheet_webhook_url IS NOT NULL AS has_webhook,
--        cc_emails,
--        active,
--        agreement_signed_at
--   FROM crm.providers
--  ORDER BY agreement_signed_at, provider_id;
--
-- Expected: 3 rows (enterprise-made-simple, courses-direct, wyk-digital);
-- all active = true, agreement_signed_at populated, has_sheet_id + has_webhook
-- true after Parts 2 and 3 are applied; cc_emails = {ranjit@courses-direct.co.uk}
-- for courses-direct, empty for the other two.
