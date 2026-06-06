-- Migration 0193 — add far-future rocks to the Roadmap + enrich the migrated Hub tasks
-- Date: 2026-06-06
-- Author: Claude (Mira) with owner review
-- Reason: (1) the 5 far-future income-stream initiatives that weren't yet Build
--   rocks (they lived only in master-plan/business-reference) — add them so
--   nothing future lives only in ClickUp. (2) enrich the migrated Run tasks with
--   tags (big-project / quick-win) + the genuine hard due dates. Owner sets the
--   rest of the dates/tags on the cards. Completes the ClickUp retirement.
-- Related: strategy.roadmap_tasks, strategy.tasks, admin-work-hub-spec.md.

-- UP
-- (1) Far-future rocks (Build tab, deferred-phase-2 lane).
INSERT INTO strategy.roadmap_tasks (title, description, lane, lane_sort_order, revenue_model, phase, agent_tags, status, sort_order) VALUES
  ('Recruitment lead gen (sell learner profiles to employers)', 'Phase 3 income stream. Same learner data, different buyer. Needs GDPR recruitment-consent scoping.', 'deferred-phase-2', 99, 'placements', 'p3', '{}', 'to_do', 210),
  ('Learner shared-leads model (sell to 2-3 providers at lower price)', 'Phase 2 pricing option: non-exclusive higher-intent leads at lower per-lead price.', 'deferred-phase-2', 99, 'provider', 'p2', '{}', 'to_do', 211),
  ('Outplacement partnerships (B2B employer redundancy retraining)', 'Phase 2-3. Employers fund retraining for redundant staff; parked, Q4 2026 review.', 'deferred-phase-2', 99, 'placements', 'p3', '{}', 'to_do', 212),
  ('Database reactivation package (re-engage ITPs'' dead leads)', 'Phase 2 service: re-engage providers'' dormant lead lists.', 'deferred-phase-2', 99, 'provider', 'p2', '{}', 'to_do', 213),
  ('Geographic expansion (Wales, Scotland, Ireland, then international)', 'Phase 5. Replicate the model beyond England; paid social scales across borders.', 'deferred-phase-2', 99, 'foundation', 'p4', '{}', 'to_do', 214);

-- (2a) big-project tag on the major builds/initiatives.
UPDATE strategy.tasks SET tags = ARRAY['big-project']
WHERE notes ~ '(869djrtgk|869dh8mr7|869ddyj3b|869d8mpmx|869d4uakk|869dcwp8a|869cu679q|869cyxr3f)';

-- (2b) quick-win tag on the small contained jobs.
UPDATE strategy.tasks SET tags = ARRAY['quick-win']
WHERE notes ~ '(869d9vhm2|869d4amcu|869db1215)';

-- (2c) genuine hard due dates only.
UPDATE strategy.tasks SET due_date = '2026-06-30' WHERE notes LIKE '%869d4hxe0%'; -- Presumed Enrolment mechanic, before June billing
UPDATE strategy.tasks SET due_date = '2026-06-09' WHERE notes LIKE '%869dd9g21%'; -- funded-form regression, urgent live bug

-- DOWN
-- DELETE FROM strategy.roadmap_tasks WHERE sort_order BETWEEN 210 AND 214 AND lane = 'deferred-phase-2';
-- UPDATE strategy.tasks SET tags = '{}', due_date = NULL WHERE notes LIKE 'Migrated from ClickUp %';
