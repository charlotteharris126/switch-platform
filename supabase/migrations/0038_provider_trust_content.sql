-- Migration 0038 — add provider trust content columns to crm.providers
-- Date: 2026-04-29
-- Author: Claude (platform session) with owner sign-off (Option C in cross-project email/platform decision)
-- Reason: Switchable email launch needs trust_line, funding_types, regions
-- and voice_notes pushed to Brevo as contact attributes when routing-confirm
-- runs. The Tuesday 28 Apr Path 4 (YAML-native) decision assumed Edge
-- Functions could read switchable/site/deploy/data/providers/*.yml at
-- runtime — they cannot (no filesystem access to the Switchable site
-- repo). Reversing to a single source of truth in crm.providers, fed
-- into Brevo by routing-confirm.
--
-- Backfilled from the three existing provider YAMLs verbatim so the
-- migration is the cutover. After this lands the YAMLs in
-- switchable/site/deploy/data/providers/ become read-references rather
-- than runtime sources. /new-course-page skill should still capture
-- trust content the same way (one-time per provider), then write to
-- crm.providers instead of YAML.
--
-- Schema versioning: this is an additive change to crm.providers
-- (new columns, all NULL-able initially, defaults set after backfill
-- where applicable). Per .claude/rules/schema-versioning.md additive
-- changes are free — no schema_version bump required. The lead
-- payload from the form is unchanged; only the Brevo attribute mapping
-- in routing-confirm gains new sources.
--
-- Related: switchable/email/CLAUDE.md (provider YAML format section,
-- to be updated to reflect this reversal), platform/docs/changelog.md
-- (entry forthcoming), platform/docs/data-architecture.md (must be
-- updated with the new columns).

-- UP

ALTER TABLE crm.providers
  ADD COLUMN trust_line     TEXT,
  ADD COLUMN funding_types  TEXT[],
  ADD COLUMN regions        TEXT[],
  ADD COLUMN voice_notes    TEXT;

COMMENT ON COLUMN crm.providers.trust_line IS
  'Marketing prose used in Switchable learner emails as PROVIDER_TRUST_LINE Brevo attribute. Sits after "This course is delivered by {{PROVIDER_NAME}}." in the email body. Voice: warm, factual, confident. No em dashes.';

COMMENT ON COLUMN crm.providers.funding_types IS
  'Array of funding routes this provider operates in. Allowed values: gov, self, loan. Used for routing eligibility and FUNDING_CATEGORY/FUNDING_ROUTE Brevo attribute composition.';

COMMENT ON COLUMN crm.providers.regions IS
  'Array of region slugs this provider currently delivers in. Slugs match files in switchable/site/deploy/data/regions/. Used for REGION_NAME Brevo attribute and routing checks.';

COMMENT ON COLUMN crm.providers.voice_notes IS
  'Internal notes for Claude when drafting fresh copy about this provider. Sector context, terminology preferences, sensitivities. Not pushed to Brevo. Read by /new-course-page and the email skill.';

-- Backfill from current YAML content. Verbatim transcription as of
-- 2026-04-29 — keeps the cutover honest. Future edits go to the DB,
-- not the YAML files.

UPDATE crm.providers
SET
  trust_line = $$They've been running funded training since 2008, deliver accredited counselling qualifications, and are 5-star rated on Google.$$,
  funding_types = ARRAY['gov']::TEXT[],
  regions = ARRAY['tees-valley']::TEXT[],
  voice_notes = $$Sector lead is counselling. Andy Fay is the named contact. Counselling course material is relational and emotion-focused; keep learner emails grounded and reassuring rather than career-pushy.$$
WHERE provider_id = 'enterprise-made-simple'
  AND trust_line IS NULL;

UPDATE crm.providers
SET
  trust_line = $$They're an Ofsted-registered training provider and multi-award-winning social enterprise, delivery partners for the DfE, the GLA and the Prince's Trust, with 1,100+ graduates and 69% going into permanent work within six months.$$,
  funding_types = ARRAY['gov']::TEXT[],
  regions = ARRAY['lift-boroughs']::TEXT[],
  voice_notes = $$Sector lead is digital marketing (LIFT Futures cohort). Heena Uppal is the named contact. WYK runs short, intense cohorts with hard interview windows, so timing language in learner emails should reflect that ("they'll move quickly", explicit deadline framing where applicable).$$
WHERE provider_id = 'wyk-digital'
  AND trust_line IS NULL;

UPDATE crm.providers
SET
  trust_line = $$They've been running distance learning courses for UK adults for over 20 years, covering business, healthcare, IT and more, and are listed on the UK Register of Learning Providers.$$,
  funding_types = ARRAY['self']::TEXT[],
  regions = ARRAY['nationwide']::TEXT[],
  voice_notes = $$Mixed-sector self-funded distance learning specialist. Catalogue spans business, healthcare, IT, animal care and more. Appeal is breadth (lots of choice) and flexibility (self-paced, fits around current commitments), not specialist outcomes. Marty Mallhi is the named contact. Keep learner emails grounded in the practical "study at your own pace" angle rather than career-pushy.$$
WHERE provider_id = 'courses-direct'
  AND trust_line IS NULL;

-- Grants. readonly_analytics already has SELECT on crm.providers (per
-- migration 0001 / 0016). New columns inherit the table-level grant.
-- routing-confirm runs as the service role and reads via supabase-js
-- with the service-role key, no extra grant needed.

-- DOWN
-- ALTER TABLE crm.providers
--   DROP COLUMN voice_notes,
--   DROP COLUMN regions,
--   DROP COLUMN funding_types,
--   DROP COLUMN trust_line;
