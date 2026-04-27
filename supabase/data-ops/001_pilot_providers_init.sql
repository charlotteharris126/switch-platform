-- Data-ops 001 — Pilot providers initial insert
-- Date: 2026-04-18
-- Author: Claude (Session 2 kickoff) with owner review
-- Reason: Seed crm.providers with the two onboarded pilot providers so n8n routing has targets to match against.
--         Avoids coupling Session 2 routing build to Session 5 (Provider Sheet cutover).
-- Related: platform/docs/data-architecture.md (crm.providers shape)
--          accounts-legal/changelog.md entries for 13 April 2026 (EMS and Courses Direct signings)
--
-- Not a schema migration — this is data only, safe to re-run (ON CONFLICT DO NOTHING).
--
-- Before running:
--   1. Owner reviews provider_id slugs (`enterprise-made-simple`, `courses-direct`). These match the
--      example in switchable/site/docs/funded-funnel-architecture.md and are the format that will
--      carry through to the phase 4 marketplace (app.switchleads.co.uk/provider/<slug>). Short alias
--      "EMS" is preserved in the notes field for internal reference. Course YAML files do not yet
--      reference providers, so there is no existing consumer to invalidate.
--   2. Owner reviews the contact_phone field — left NULL because phone numbers aren't in our records yet.
--      Fill in before running if known; otherwise leave NULL and update later via an UPDATE statement.
--   3. Run as the service role (postgres) via Supabase SQL editor. Scoped roles cannot INSERT here.

INSERT INTO crm.providers (
  provider_id,
  company_name,
  contact_name,
  contact_email,
  contact_phone,
  crm_webhook_url,
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
  agreement_notion_page_id,
  notes
) VALUES
  -- EMS (Enterprise Made Simple) — first formally signed provider
  (
    'enterprise-made-simple',
    'Enterprise Made Simple',
    'Andy Fay',
    'andy@enterprisemadesimple.co.uk',
    NULL,
    NULL, -- no CRM webhook yet; delivery via email until provider integrates
    'pilot',
    'per_enrolment_flat',
    150.00,
    NULL,
    NULL,
    NULL,
    3,
    true,
    '2026-04-13 00:00:00+00',
    '2026-04-13 00:00:00+00',
    NULL, -- Fillout-signed agreement PDF stored externally; no dedicated Notion page per provider yet
    $$Internal alias: "EMS". FCFJ/Skills Bootcamp delivery. TVCA and NECA prime contractor. Fully funded pricing, £150/enrolment permanent pilot rate. Two courses on pilot: TV Level 3 Social Media and E-Commerce (FCFJ), TV L3 Diploma in Counselling Skills (FCFJ). Both in-person at HQ, 10 sessions May-July 2026. SLA: first contact within 24hrs, 3 attempts (call, text, email). Source: accounts-legal/changelog.md 13 April 2026 entry.$$
  ),
  -- Courses Direct — second formally signed (same day)
  (
    'courses-direct',
    'Courses Direct',
    'Marty Mallhi',
    'marty@courses-direct.co.uk',
    NULL,
    NULL,
    'pilot',
    'per_enrolment_percent',
    NULL,
    0.1500, -- 15%
    75.00,
    150.00,
    3,
    true,
    '2026-04-13 00:00:00+00',
    '2026-04-13 00:00:00+00',
    NULL,
    $$Self-funded online courses, £299-£4000. 150+ courses, 6-month learner access each. Pilot covers full catalogue (not narrowed). Targeting approach: ads push most-likely-to-convert courses first, full catalogue stays available for learner matching. Pricing: 15% of course fee, min £75, max £150, permanent pilot rate. Also: Marty is director of Premier Solutions (employer-led funded training) — separate pilot track not in scope yet. Co-director Ranjit on 4pm strategy calls. SLA: Marty calls within 24hrs, minimum 3 attempts. CC email: ranjit@courses-direct.co.uk. Source: accounts-legal/changelog.md 9 + 13 April 2026 entries.$$
  )
ON CONFLICT (provider_id) DO NOTHING;

-- Verification (run after the INSERT)
-- Expected: 2 rows, active = true, pilot_status = 'pilot'
SELECT provider_id, company_name, pricing_model, per_enrolment_fee, percent_rate, active, agreement_signed_at
FROM crm.providers
ORDER BY provider_id;
