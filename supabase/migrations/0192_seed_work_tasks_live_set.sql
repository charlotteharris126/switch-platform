-- Migration 0192 — import the live working set from ClickUp into the Work Hub
-- Date: 2026-06-06
-- Author: Claude (Mira triage + Sasha apply) with owner review
-- Reason: second + main migration pass. After triaging the full ClickUp Task
--   pipeline (174) + Backlog (56), this imports the ~30 genuinely live/forward
--   tasks (on top of the 10 from 0191). The Hub is now home; the ClickUp pipeline
--   is abandoned in place (cruft + done-but-unclosed tickets left to die there,
--   not laboriously closed). The phase-2-5 Backlog stays in ClickUp as the
--   "someday" idea list. Titles cleaned of em dashes per copy rules.
-- Related: platform/docs/admin-work-hub-spec.md, strategy/docs/current-handoff.md.

-- UP
INSERT INTO strategy.tasks (title, notes, status, priority, area_tag, added_by) VALUES
  -- platform
  ('Codex security audit remediation (2026-06-01): remaining findings', 'Migrated from ClickUp 869dh8mr7', 'inbox', 'high', 'platform', 'charlotte'),
  ('Billing reconciliation + /admin/billing (per-lead billed/paid view)', 'Migrated from ClickUp 869djrtgk', 'inbox', 'high', 'platform', 'charlotte'),
  ('Move leads.submissions reporting onto an email-free view (PII minimisation)', 'Migrated from ClickUp 869dja09z', 'inbox', 'normal', 'platform', 'charlotte'),
  ('Labs endpoint hardening before ad spend', 'Migrated from ClickUp 869dja78d', 'inbox', 'normal', 'platform', 'charlotte'),
  ('Map view to pin leads by location', 'Migrated from ClickUp 869djrwhu', 'inbox', 'low', 'platform', 'charlotte'),
  ('Phase 2 CMS admin pages for blog (editorial schema)', 'Migrated from ClickUp 869ddyj3b', 'in_progress', 'high', 'platform', 'charlotte'),
  ('Auto-flip mechanic: open to presumed to notify to enrolled, with audit trail', 'Migrated from ClickUp 869d4eam6', 'in_progress', 'high', 'platform', 'charlotte'),
  ('S4B v1 backend: Edge Function + DB columns + Riverside Sheet + Brevo wiring', 'Migrated from ClickUp 869d8mpmx', 'in_progress', 'high', 'platform', 'charlotte'),
  ('Brevo reconcile panel: EF self-chunking apply (replace timeout-prone chunk-loop)', 'Migrated from ClickUp 869dgua4w', 'inbox', 'normal', 'platform', 'charlotte'),
  ('Republish sheet drift for affected providers (12 unreplayed rows)', 'Migrated from ClickUp 869db1215', 'inbox', 'normal', 'platform', 'charlotte'),
  -- strategy
  ('Run revenue modelling session', 'Migrated from ClickUp 869cu6793', 'inbox', 'high', 'strategy', 'charlotte'),
  ('Scope post-pilot pricing: move SwitchLeads off pilot pricing', 'Migrated from ClickUp 869djrt98', 'inbox', 'normal', 'strategy', 'charlotte'),
  ('Set apprenticeship post-pilot rate card (500-750 + CPL)', 'Migrated from ClickUp 869d64hjh', 'inbox', 'high', 'strategy', 'charlotte'),
  ('Career Change Field Guide: write + launch (Q3 flagship content asset)', 'Migrated from ClickUp 869dcwp8a', 'inbox', 'high', 'strategy', 'charlotte'),
  ('Affiliate Tier 1 sign-ups: Amazon, Awin, Skimlinks, TopCV, Reed, Coursera', 'Migrated from ClickUp 869dcwpbf', 'inbox', 'high', 'strategy', 'charlotte'),
  -- switchable-site
  ('Diagnose funded-form regression on switchable.org.uk (since 2026-05-18)', 'Migrated from ClickUp 869dd9g21', 'this_week', 'urgent', 'switchable-site', 'charlotte'),
  ('Reframe /business/ pages: drop "apprenticeship" + add company qualifier', 'Migrated from ClickUp 869djrt8y', 'this_week', 'high', 'switchable-site', 'charlotte'),
  ('Extend fastrack flow to self-funded thank-you page', 'Migrated from ClickUp 869dda323', 'inbox', 'normal', 'switchable-site', 'charlotte'),
  -- switchable-ads
  ('Fresh generic B2B employer ads for Riverside expansion (drop "apprenticeship")', 'Migrated from ClickUp 869djrt97', 'this_week', 'high', 'switchable-ads', 'charlotte'),
  ('Rotate Meta CAPI access token (B2B Switchable Business pixel)', 'Migrated from ClickUp 869d9vhm2', 'inbox', 'high', 'switchable-ads', 'charlotte'),
  -- switchleads-clients
  ('Diagnose Courses Direct pipeline blockage (0/12 outcome rate)', 'Migrated from ClickUp 869dda303', 'this_week', 'high', 'switchleads-clients', 'charlotte'),
  ('Provider sales pack: Switchable channel intel for pilot ITPs', 'Migrated from ClickUp 869d4uakk', 'inbox', 'high', 'switchleads-clients', 'charlotte'),
  ('Review: Switchable for Business v1 launch (Riverside Employer Lead campaign)', 'Migrated from ClickUp 869d7u003', 'review', 'high', 'switchleads-clients', 'charlotte'),
  -- accounts-legal
  ('Switchable Labs: privacy policy + terms covering CV/email handling', 'Migrated from ClickUp 869dh7ruc', 'this_week', 'high', 'accounts-legal', 'charlotte'),
  ('Presumed Enrolment heads-up + dispute window mechanic (before June billing)', 'Migrated from ClickUp 869d4hxe0', 'this_week', 'high', 'accounts-legal', 'charlotte'),
  ('Watch SUL portal for 15,000 loan underwriter decision', 'Migrated from ClickUp 869dbnjc1', 'inbox', 'high', 'accounts-legal', 'charlotte'),
  ('File DPAs for all PII-handling vendors in Notion', 'Migrated from ClickUp 869d4amcu', 'inbox', 'normal', 'accounts-legal', 'charlotte'),
  -- email
  ('Build Brevo Automations for SwitchLeads provider sequences', 'Migrated from ClickUp 869cu679q', 'inbox', 'high', 'switchleads-email', 'charlotte'),
  ('Build Brevo Automations for Switchable learner (utility + nurture)', 'Migrated from ClickUp 869cyxr3f', 'inbox', 'high', 'switchable-email', 'charlotte'),
  -- social
  ('Watch legal@switchable.org.uk for Microsoft Vetting + LinkedIn approval', 'Migrated from ClickUp 869d1yevx', 'inbox', 'high', 'switchleads-social', 'charlotte');

-- DOWN
-- DELETE FROM strategy.tasks WHERE notes LIKE 'Migrated from ClickUp %' AND added_by = 'charlotte' AND created_at > '2026-06-06';
