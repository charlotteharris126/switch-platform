-- Migration 0191 — seed the Work Hub with the live in-flight task subset
-- Date: 2026-06-06
-- Author: Claude (Mira triage + Sasha apply) with owner review
-- Reason: first partial migration from ClickUp into strategy.tasks. NOT the full
--   cull (150+ ClickUp tasks need a proper Monday triage). This is the small,
--   high-confidence set of currently in-flight / urgent-compliance tasks, hand-
--   mapped so the Hub isn't empty. These 10 also still exist in ClickUp until the
--   full migration reconciles + retires the pipeline. One-time data seed.
-- Related: platform/docs/admin-work-hub-spec.md, strategy/docs/current-handoff.md.

-- UP
INSERT INTO strategy.tasks (title, notes, status, priority, area_tag, added_by) VALUES
  ('Write ROPA (Record of Processing Activities)', 'Migrated from ClickUp 869cu672z', 'this_week', 'urgent', 'accounts-legal', 'charlotte'),
  ('Appoint an accountant for Switchable Ltd', 'Migrated from ClickUp 869cu6cp9', 'inbox', 'high', 'accounts-legal', 'charlotte'),
  ('Consent re-consent: process replies + delete non-responders', 'Migrated from ClickUp 869d0x51z', 'this_week', 'high', 'accounts-legal', 'charlotte'),
  ('Marty: how do I bill now we''re letting loads of courses in?', 'Migrated from ClickUp 869cwhxww', 'review', 'high', 'accounts-legal', 'charlotte'),
  ('Email nurturing: welcome + follow-up sequences for new leads', 'Migrated from ClickUp 869cvpnjf', 'in_progress', 'high', 'switchable-email', 'charlotte'),
  ('Email outreach step: turn on in Rosa''s escalation sequence', 'Migrated from ClickUp 869cvpnjz', 'review', 'high', 'switchleads-outreach', 'charlotte'),
  ('Template fixes: mini qualifier UX + submit overlay timing', 'Migrated from ClickUp 869cy0qut', 'in_progress', 'high', 'switchable-site', 'charlotte'),
  ('Widen Tees Valley employment eligibility (suspected silent lead leakage)', 'Migrated from ClickUp 869d0gexn', 'this_week', 'high', 'switchable-site', 'charlotte'),
  ('Meta Marketing API ingestion into ads_switchable.meta_daily', 'Migrated from ClickUp 869d11r2z', 'in_progress', 'normal', 'platform', 'charlotte'),
  ('Waitlist enrichment causes lead duplication: fix data model', 'Migrated from ClickUp 869d200ta', 'inbox', 'high', 'platform', 'charlotte');

-- DOWN
-- DELETE FROM strategy.tasks WHERE notes LIKE 'Migrated from ClickUp %' AND added_by = 'charlotte';
