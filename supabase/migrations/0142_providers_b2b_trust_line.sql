-- Migration 0142 — add b2b_trust_line to crm.providers
-- Date:   2026-05-15
-- Author: Sasha (Charlotte's session)
-- Reason:
--   The U1-employer Brevo template now references
--   `{{contact.B2B_PROVIDER_TRUST_LINE}}`. The Sasha-side upsert
--   (netlify-employer-lead-router/index.ts, upsertEmployerInBrevo)
--   needs a provider-level column to read from before it can push
--   that attribute. New B2B-specific column rather than reusing the
--   existing `trust_line` column (which is wired into the funded
--   learner U1 path via SW_PROVIDER_TRUST_LINE) because the audience
--   register diverges: HRDs and L&D managers read differently to
--   adult learners, so the same prose won't always fit both.
--   Forking at the schema layer now beats a re-template at v2 per
--   feedback_no_patchwork.md.
--
--   `b2b_trust_line` is nullable so existing rows don't fail. Mable's
--   /new-apprenticeship-provider skill update will prompt for the
--   value at onboarding time and write it through. Riverside row is
--   backfilled in data-ops 032 immediately after this lands.
--
-- UP
ALTER TABLE crm.providers
  ADD COLUMN b2b_trust_line TEXT;

-- DOWN
-- ALTER TABLE crm.providers DROP COLUMN b2b_trust_line;
