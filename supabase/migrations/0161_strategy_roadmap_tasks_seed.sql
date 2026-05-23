-- Migration 0161 — Seed strategy.roadmap_tasks with the 2026-05-23 pivot build sequence
-- Date: 2026-05-23
-- Author: Claude (Sasha / platform Session 58) on Mira's PUSH from strategy Session 16
-- Reason: Populate the new strategy.roadmap_tasks table (created in 0160) with the
--   ~85 tasks from strategy/roadmap.html and strategy/docs/build-map.md, pre-categorised
--   by revenue_model + phase + agent_tags. Tasks already complete at seed time
--   (TEES-VALLEY-SMM paused, signups initiated, strategic docs shipped, recent
--   conversion improvements deployed) start with status='complete' and completed_at set.
--
--   Source of truth for the task list:
--   - strategy/docs/build-map.md (operational build sequence + ship dates)
--   - strategy/roadmap.html (visual reference, project-by-project view)
--   - strategy/docs/product-and-revenue-map.md (5 modules + cash compression plan)
--   - strategy/docs/audience-business-pivot.md (strategic frame)
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: data-only INSERT of ~85 rows into strategy.roadmap_tasks. Zero schema change.
--   2. Readers affected: future /admin/roadmap page (Mable, TBD); Mira's MCP query path.
--   3. Writers affected: none here. Future writes via /admin/roadmap admin page.
--   4. Schema version: 1.0 (matches table default).
--   5. Data migration: idempotent INSERTs via title-unique check would be ideal, but
--      table has no unique constraint on title. Re-applying this migration would
--      duplicate rows. Mitigation: wrap in a guard that aborts if any rows already
--      exist in strategy.roadmap_tasks.
--   6. Role / policy: none new.
--   7. Rollback: DOWN deletes all rows inserted by this migration via a TRUNCATE.
--   8. Sign-off: owner via strategy Session 16 (2026-05-23) decision lock.

BEGIN;

-- Idempotency guard
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM strategy.roadmap_tasks LIMIT 1) THEN
    RAISE EXCEPTION 'strategy.roadmap_tasks already populated; aborting seed migration 0161 to prevent duplicates';
  END IF;
END $$;

-- =============================================================================
-- Foundation tasks (cross-cutting, enable every revenue model)
-- =============================================================================

INSERT INTO strategy.roadmap_tasks (title, description, revenue_model, phase, agent_tags, status, completed_at, sort_order) VALUES
('Pause TEES-VALLEY-SMM, concentrate spend on working creative', 'EMS counselling + SMM courses paused (cohorts full). New EMS course campaign launched at £50/day same day.', 'foundation', 'p1', '{iris}', 'complete', '2026-05-23 12:00:00+00', 10),
('Strategic docs shipped (audience-business-pivot.md, product-and-revenue-map.md, build-map.md, roadmap.html)', 'Four strategy docs written 2026-05-23 capturing the audience-business pivot, 5-module PPL stack, cash compression plan, and visual roadmap.', 'foundation', 'p1', '{mira,claude}', 'complete', '2026-05-23 17:00:00+00', 20),
('Update .claude/rules/business.md with audience-first model + step 5 + sub-steps 4a-4i', 'Business model section updated with 8 revenue lanes, step 5 (build audience asset) added, sub-steps 4a-4i (first £1 non-enrolment revenue through semi-passive).', 'foundation', 'p1', '{mira}', 'complete', '2026-05-23 17:30:00+00', 30),
('Strategy changelog entry for the audience-business pivot', 'Material milestone logged in strategy/changelog.md.', 'foundation', 'p1', '{mira}', 'complete', '2026-05-23 17:35:00+00', 40),
('/admin/roadmap MVP spec written', 'Spec doc at platform/docs/admin-roadmap-spec.md detailing schema, API endpoints, frontend requirements, Mira integration pattern.', 'foundation', 'p1', '{mira}', 'complete', '2026-05-23 16:30:00+00', 50),
('/admin/roadmap schema migration (0160) written', 'platform/supabase/migrations/0160_strategy_roadmap_tasks.sql — creates schema, table, 3 indexes, 1 trigger, 2 RLS policies. Ready to apply, not yet pushed.', 'foundation', 'p1', '{sasha}', 'in_progress', NULL, 60),
('/admin/roadmap seed migration (0161) written', 'platform/supabase/migrations/0161_strategy_roadmap_tasks_seed.sql — this migration. ~85 tasks pre-categorised.', 'foundation', 'p1', '{sasha,mira}', 'in_progress', NULL, 70),
('Apply migrations 0160 + 0161 to production via supabase db push', 'After Charlotte review. Validates schema + seed in one go.', 'foundation', 'p1', '{sasha,charlotte}', 'to_do', NULL, 80),
('/admin/roadmap Edge Function endpoints (GET list, PATCH update, POST add)', 'Three CRUD endpoints in platform/supabase/functions/admin-roadmap/. Auth pattern matches existing /admin/* routes. ~6-9 hours Sasha effort.', 'foundation', 'p1', '{sasha}', 'to_do', NULL, 90),
('/admin/roadmap frontend admin page', 'Mable build at /admin/roadmap. Grouped by revenue_model, status dropdown inline, notes textarea, auto-save debounced 500ms, mobile-friendly, filter buttons. ~4-6 hours.', 'foundation', 'p1', '{mable}', 'to_do', NULL, 100),
('Awin signup', 'Primary UK affiliate network. Processing 2026-05-23, expected approval 2-5 working days.', 'foundation', 'p1', '{charlotte}', 'in_progress', NULL, 110),
('Skimlinks signup', 'Auto-linker for blog + Free Guide content. Pending approval 2026-05-23, expected 24-72 hours.', 'foundation', 'p1', '{charlotte}', 'in_progress', NULL, 120),
('Coursera affiliate signup (via Impact)', 'Done 2026-05-23. Impact network also now available for other brands.', 'foundation', 'p1', '{charlotte}', 'complete', '2026-05-23 16:00:00+00', 130),
('Amazon Associates: dormant account reactivated with Switchable email', 'Old account reactivated. Outstanding: add Switchable-branded tracking ID, update payout to Mettle, update tax to Switchable Ltd.', 'foundation', 'p1', '{charlotte}', 'in_progress', NULL, 140),
('Amazon Associates: add Switchable tracking ID + update payout/tax', '~10 mins inside the reactivated account. Switchable tracking ID for clean revenue attribution; payout to Mettle; tax info to Switchable Ltd.', 'foundation', 'p1', '{charlotte}', 'to_do', NULL, 150),
('Skimlinks script install on switchable.org.uk', 'Single <script> tag before </body> in base layout. Spec at switchable/site/docs/pending-skimlinks-install.md. Affiliate ID 303509X1791558.', 'foundation', 'p1', '{mable}', 'to_do', NULL, 160),
('Career change blog template + first 4 posts drafted', 'Blog launches as audience-acquisition + affiliate placement + newsletter content + social content source. Mable template, Claude drafts, Charlotte edits.', 'foundation', 'p1', '{mable,claude,charlotte}', 'to_do', NULL, 170),
('Blog cadence: 1 post per week', 'Ongoing weekly cadence from Week 4-5 onwards. Charlotte ~1-2 hrs editing per post.', 'foundation', 'p1', '{mable,claude,charlotte}', 'to_do', NULL, 180),
('Free Guide AI-drafted → Charlotte edits → live', 'UK Career Change Field Guide. Workbook + Skills Translator + salary negotiation + interview prep all folded in as free content throughout. ~6-10 hrs Charlotte editing.', 'foundation', 'p1', '{claude,charlotte,mable}', 'to_do', NULL, 190),
('AI Career Switcher tool live (free version only)', 'Top-of-funnel lead capture: 5-question AI quiz → 3 ranked career suggestions + funded training routes + email signup. OpenAI API backend.', 'foundation', 'p1', '{mable,sasha}', 'to_do', NULL, 200),
('Newsletter Brevo template + first 4 launch issues drafted', 'Weekly "UK Career Change & Funded Training" newsletter. Free for all, monetised by sponsorship + affiliate + Members promo.', 'foundation', 'p1', '{wren,charlotte}', 'to_do', NULL, 210),
('Newsletter weekly cadence ongoing', 'Target 1.5k subs by month 3, 3-5k by month 6, 10k+ by month 12-18 (sponsorship threshold).', 'foundation', 'p1', '{wren,charlotte}', 'to_do', NULL, 220),
('Charity / relationship partner outreach motion starts', 'Mind, Citizens Advice, StepChange, JCP, unions, refugee support, domestic abuse, disability, veteran transition, maternity, faith, local councils. Free-help-only contract.', 'foundation', 'p1', '{solis}', 'to_do', NULL, 230),
('Target 2-3 active charity partners by month 3', 'First wave of relationship-based referrals.', 'foundation', 'p1', '{solis}', 'to_do', NULL, 240),
('Target 10 active charity partners by month 9', 'Scale relationship lane to 100-300 free referrals/month at maturity.', 'foundation', 'p2', '{solis}', 'to_do', NULL, 250),
('Programmatic SEO scoping + first batch of generated pages', 'Page generation system for UK area × course type × career path. 5k-50k pages indexed within 12 months.', 'foundation', 'p2', '{mable}', 'to_do', NULL, 260),
('Programmatic SEO compounding (10k+ pages indexed)', 'Organic acquisition lane mature.', 'foundation', 'p3', '{mable}', 'to_do', NULL, 270),
('Pinterest organic content library scoping (200-pin career change library)', 'Evergreen content. One pin drives traffic for years.', 'foundation', 'p2', '{nina}', 'to_do', NULL, 280),
('Paid TikTok creator on retainer (£400-600/month)', '12-15 posts/month, real human, authentic voice builds trust faster than AI-only.', 'foundation', 'p2', '{nina}', 'to_do', NULL, 290),
('YouTube/podcast media strategy scoping', 'Career Change Story video series + Funded Training Spotlight podcast. Sponsorable long-form content.', 'foundation', 'p2', '{nina,charlotte}', 'to_do', NULL, 300),
('Long-form YouTube/podcast content production starts', 'Sponsored content slots opened at audience scale.', 'foundation', 'p3', '{nina}', 'to_do', NULL, 310);

-- =============================================================================
-- Provider per-enrolment (existing lead-gen line, ongoing improvements)
-- =============================================================================

INSERT INTO strategy.roadmap_tasks (title, description, revenue_model, phase, agent_tags, status, completed_at, sort_order) VALUES
('New EMS course campaign £50/day running', 'B2C funded course funnel, post-counselling-cohort-full state. Launched 2026-05-23.', 'provider', 'p1', '{iris}', 'complete', '2026-05-23 12:00:00+00', 10),
('SMS welcome conversion improvement deployed', 'Lifts form-to-first-contact by 30-50%.', 'provider', 'p1', '{sasha}', 'complete', '2026-05-22 12:00:00+00', 20),
('Fastrack conversion improvement deployed', 'Explicit qualification step, higher-intent leads delivered to providers.', 'provider', 'p1', '{sasha}', 'complete', '2026-05-22 12:00:00+00', 30),
('Provider portal conversion improvement deployed', 'Reduces provider admin friction.', 'provider', 'p1', '{mable}', 'complete', '2026-05-22 12:00:00+00', 40),
('Phone-number-in-email deployed', 'Lifts provider responsiveness perception (~20%).', 'provider', 'p1', '{wren}', 'complete', '2026-05-22 12:00:00+00', 50),
('Provider reconciliation deadline 31 May', 'Providers update lead statuses before auto-flip cron applies 1 June. EMS 30 old leads decision pending.', 'provider', 'p1', '{charlotte,nell}', 'in_progress', NULL, 60),
('Auto-flip cron migration 0097 applied prospectively from 1 June', 'Existing carry from S51/S54/S55/S56 platform sessions. Pre-conditions: Brevo warning template, provider heads-up emails, activity-gate framework.', 'provider', 'p1', '{sasha}', 'to_do', NULL, 70),
('Scale ad spend back to £150-200/day once breakeven holds', 'Triggered by month 3-4 breakeven confirmation.', 'provider', 'p2', '{iris}', 'to_do', NULL, 80),
('EMS + WYK + Courses Direct + Riverside relationship management ongoing', 'Ongoing Nell-led provider success across the four pilot providers.', 'provider', 'p1', '{nell}', 'in_progress', NULL, 90);

-- =============================================================================
-- Apprenticeship Employer Signed (Riverside live)
-- =============================================================================

INSERT INTO strategy.roadmap_tasks (title, description, revenue_model, phase, agent_tags, status, completed_at, sort_order) VALUES
('Riverside B2B apprenticeship ads running £50/day', 'B2B Employer Lead funnel via Solis. Live since campaign launch ~2026-05-13.', 'apprenticeship', 'p1', '{solis}', 'complete', '2026-05-13 09:00:00+00', 10),
('First Riverside Employer Signed event', 'Watch for this signal in Phase 1 month 1-2. Proves the B2B apprenticeship line economics.', 'apprenticeship', 'p1', '{solis,nell}', 'to_do', NULL, 20),
('Apprenticeship line scaling (more campaigns, sector tests)', 'After first Employer Signed confirms unit economics.', 'apprenticeship', 'p2', '{solis}', 'to_do', NULL, 30),
('Second apprenticeship provider sign (target: month 4-7)', 'Rosa-led outreach to apprenticeship ITPs. Diversifies beyond Riverside.', 'apprenticeship', 'p2', '{rosa}', 'to_do', NULL, 40),
('Apprenticeship post-pilot rate card decision', 'ClickUp 869d64hjh, 12+ days overdue. £500-£750 + CPL set in business.md + Notion before next apprenticeship prospect call.', 'apprenticeship', 'p1', '{mira,charlotte}', 'to_do', NULL, 50);

-- =============================================================================
-- Affiliate stack (cookie-based, 5 modules)
-- =============================================================================

INSERT INTO strategy.roadmap_tasks (title, description, revenue_model, phase, agent_tags, status, completed_at, sort_order) VALUES
('Affiliate links wired into existing 5 Brevo welcome emails (Module 1)', 'TopCV, Reed, Coursera, LinkedIn Learning, Amazon books. Single quickest revenue lever. £100-£400/month within 6-8 weeks. Gated on Awin approval.', 'affiliate', 'p1', '{sasha,wren}', 'to_do', NULL, 10),
('DQ-to-affiliate landing pages backend routing', 'Route disqualified leads to affiliate partners by DQ reason.', 'affiliate', 'p1', '{sasha,mable}', 'to_do', NULL, 20),
('DQ-to-affiliate landing pages frontend', 'Mable builds the landing pages that match DQ reason to affiliate partner category.', 'affiliate', 'p1', '{mable}', 'to_do', NULL, 30),
('Affiliate placements embedded throughout Free Guide PDF', 'TopCV, Reed, Coursera, Amazon books contextual to chapter content.', 'affiliate', 'p1', '{mable,charlotte}', 'to_do', NULL, 40),
('Affiliate placements in blog posts (contextual per post)', 'Ongoing: every blog post carries 2-3 contextual affiliate links.', 'affiliate', 'p1', '{mable,claude}', 'to_do', NULL, 50),
('Post-course affiliate burst sequence (SMS-triggered)', 'Months 3-6 after lead sign-up: CV writing, LinkedIn Premium, Reed, interview prep, salary negotiation. Highest-LTV moment.', 'affiliate', 'p1', '{sasha,wren}', 'to_do', NULL, 60),
('Module 5: Government-funded bridges resource page', 'PensionWise → Unbiased, MoneyHelper, UC checkers (entitledto, Turn2us), NHS Talking Therapies adjacent wellbeing apps, Multiply → AAT progression.', 'affiliate', 'p1', '{mable,claude,charlotte}', 'to_do', NULL, 70),
('Module 3: Self-Employed Transition affiliate signups', 'Tide direct (£75/account), Starling Business direct, Crunch, Xero, Squarespace, Companies Made Simple, Simply Business. Ship after freelance-track pages live.', 'affiliate', 'p2', '{charlotte}', 'to_do', NULL, 80),
('Module 4: Life-Admin Adjacent affiliate signups', 'Farewill (will writing), Babbel (language), NordVPN (remote work). Ship after newsletter mature.', 'affiliate', 'p2', '{charlotte}', 'to_do', NULL, 90),
('90-day kill rule per placement (review at month 3)', 'Every affiliate placement not earning £30+/mo gets killed and surface reused.', 'affiliate', 'p1', '{sasha,mira}', 'to_do', NULL, 100);

-- =============================================================================
-- PPL (consent-gated, Module 2 financial cluster)
-- =============================================================================

INSERT INTO strategy.roadmap_tasks (title, description, revenue_model, phase, agent_tags, status, completed_at, sort_order) VALUES
('Module 2 PPL consent expansion (Clara)', 'Explicit signup consent for routing learner details to FCA-regulated financial advisors / pension consolidation / income protection. UK GDPR Article 6(1)(a) consent basis.', 'ppl', 'p1', '{clara}', 'to_do', NULL, 10),
('Recruitment consent expansion (Clara, parallel to Module 2)', 'Post-training routing to recruiters/employers. Same form mechanic, separate consent tick. Revenue Q4 2026 / Q1 2027.', 'ppl', 'p1', '{clara}', 'to_do', NULL, 20),
('Career-Change Financial Planning landing page', 'Destination for dedicated PPL ad lane. Single page with consent-gated form routing to Module 2 partners.', 'ppl', 'p1', '{mable}', 'to_do', NULL, 30),
('Module 2 partner signups (PensionBee, Penfold, Unbiased, VouchedFor, income protection)', 'Direct programs for financial PPL. Some require traffic to qualify; apply when ready.', 'ppl', 'p1', '{charlotte,rosa}', 'to_do', NULL, 40),
('Dedicated PPL ad test campaign £30-50/day', 'Targets career-change-financial-planning audience independent of funded course funnel. Meta + Google Search.', 'ppl', 'p1', '{iris}', 'to_do', NULL, 50),
('2-week ROAS read on PPL ads', 'Scale only if 2x+ ROAS confirmed.', 'ppl', 'p1', '{iris}', 'to_do', NULL, 60),
('Scale PPL ad budget to £100-200/day if ROAS holds', 'Triggered by 2x+ ROAS confirmation.', 'ppl', 'p2', '{iris}', 'to_do', NULL, 70);

-- =============================================================================
-- App (Switchable Career Change Pro freemium)
-- =============================================================================

INSERT INTO strategy.roadmap_tasks (title, description, revenue_model, phase, agent_tags, status, completed_at, sort_order) VALUES
('App architecture scoping (multi-tenant subdomain routing + brand theming baked in)', 'Adds 15-25% to build effort, saves white-label refactor in Phase 3.', 'app', 'p2', '{mable,sasha}', 'to_do', NULL, 10),
('App backend build (OpenAI API, Stripe subscription, multi-tenant)', 'Sasha-side foundation for the freemium app.', 'app', 'p2', '{sasha}', 'to_do', NULL, 20),
('App frontend build (web PWA, free tier with sponsored placements + Pro tier ad-free)', 'Mable-side admin + user-facing UI.', 'app', 'p2', '{mable}', 'to_do', NULL, 30),
('App in-product email sequences', 'Wren handles in-app email automation, onboarding flows, retention.', 'app', 'p2', '{wren}', 'to_do', NULL, 40),
('Mini-course 1: Career Change Masterclass (6-week structured)', 'AI-assisted production, 1-2 hours Charlotte review.', 'app', 'p2', '{charlotte,claude}', 'to_do', NULL, 50),
('Mini-course 2: Going Freelance in the UK (4-week)', 'AI-assisted production, 1-2 hours Charlotte review.', 'app', 'p2', '{charlotte,claude}', 'to_do', NULL, 60),
('Mini-course 3: Returning to Work After Career Break (4-week)', 'AI-assisted production.', 'app', 'p2', '{charlotte,claude}', 'to_do', NULL, 70),
('Mini-course 4: AI for Career Changers (2-week)', 'AI-assisted production.', 'app', 'p2', '{charlotte,claude}', 'to_do', NULL, 80),
('App launched (free + Pro tier live)', 'Freemium app live on switchable.org.uk subdomain. Target 100 Pro subscribers by month 6.', 'app', 'p2', '{mable,sasha}', 'to_do', NULL, 90),
('Mini-course 5: Funded Training Application Masterclass', 'AI-assisted production.', 'app', 'p3', '{charlotte,claude}', 'to_do', NULL, 100),
('Mini-course 6: Sector Spotlights series', 'AI-assisted production, one per sector.', 'app', 'p3', '{charlotte,claude}', 'to_do', NULL, 110),
('Mini-course 7: Apprenticeship Pathways (for 25+ career changers)', 'AI-assisted production.', 'app', 'p3', '{charlotte,claude}', 'to_do', NULL, 120),
('Application Tracker tool added to app (Pro tier feature)', 'Real ongoing tool for tracking applications, training outcomes, employer outreach.', 'app', 'p3', '{mable,sasha}', 'to_do', NULL, 130),
('AI Interview Practice tool added to app (Pro tier feature)', 'Real-time interactive AI simulation with feedback per response.', 'app', 'p3', '{mable,sasha}', 'to_do', NULL, 140),
('Switchable Hero referral program (viral loop in app + newsletter)', 'Active users refer friends, get rewards. Compounds acquisition.', 'app', 'p2', '{sasha,mable}', 'to_do', NULL, 150),
('AI agents that DO things (auto-apply funded courses, auto-draft employer emails, auto-update LinkedIn)', 'Phase 3+ evolution of app. Next-gen Pro+ tier feature.', 'app', 'p4', '{mable,sasha}', 'to_do', NULL, 160);

-- =============================================================================
-- Newsletter sponsorship (audience scale)
-- =============================================================================

INSERT INTO strategy.roadmap_tasks (title, description, revenue_model, phase, agent_tags, status, completed_at, sort_order) VALUES
('Free Guide acquisition ads £30-50/day', 'Drives subscriber growth: 500-750 new subs/month from paid at £4-6/sub blended. Compresses time-to-5k subs from 8-10 months to 6 months.', 'newsletter-sponsorship', 'p1', '{iris}', 'to_do', NULL, 10),
('Newsletter swap partnerships with adjacent UK publishers', 'Money / career / parenting newsletters. Reciprocal placements, free.', 'newsletter-sponsorship', 'p2', '{charlotte,rosa}', 'to_do', NULL, 20),
('First newsletter sponsor outreach (at 3-5k subs threshold)', 'Sponsorship inventory definition + first cold-pitch round.', 'newsletter-sponsorship', 'p3', '{rosa,wren}', 'to_do', NULL, 30),
('First newsletter sponsor signed', 'Material milestone: first paid sponsorship revenue from audience.', 'newsletter-sponsorship', 'p3', '{rosa}', 'to_do', NULL, 40),
('Sponsorship inventory management (price discovery, sold-through tracking)', 'Ongoing inventory ops as audience scales.', 'newsletter-sponsorship', 'p3', '{wren,rosa}', 'to_do', NULL, 50);

-- =============================================================================
-- Sponsored placements (audience scale)
-- =============================================================================

INSERT INTO strategy.roadmap_tasks (title, description, revenue_model, phase, agent_tags, status, completed_at, sort_order) VALUES
('Sponsored placement inventory definition (slot types, pricing, deliverables)', 'Mira + Mable define what brands can buy on site/email surfaces.', 'placements', 'p3', '{mira,mable}', 'to_do', NULL, 10),
('Non-ITP brand outreach list (LinkedIn, MoneyHelper, Headspace, banking, parental support)', 'Cold-pitch target list, 20 brands per quarter.', 'placements', 'p3', '{rosa}', 'to_do', NULL, 20),
('First sponsored placement signed', '£500-£1k/month per slot. First brand signed.', 'placements', 'p3', '{rosa}', 'to_do', NULL, 30),
('Scale to 2-3 active placements simultaneously', '£1-2k/month combined recurring.', 'placements', 'p3', '{rosa}', 'to_do', NULL, 40);

-- =============================================================================
-- Consumer quarterly report (replaces Hidden Demand sponsorship)
-- =============================================================================

INSERT INTO strategy.roadmap_tasks (title, description, revenue_model, phase, agent_tags, status, completed_at, sort_order) VALUES
('First edition data set definition + scope', 'New consumer-facing report (Hidden Demand stays B2B-only). Different data, different audience.', 'report', 'p3', '{mira}', 'to_do', NULL, 10),
('First edition report design + production', 'Mira drafts content; Mable handles design + PDF production.', 'report', 'p3', '{mira,mable}', 'to_do', NULL, 20),
('First sponsor outreach (20 brand target list)', '£5-20k per sponsor per quarter.', 'report', 'p3', '{rosa}', 'to_do', NULL, 30),
('Ongoing quarterly cadence + sponsor cycle', 'Repeating revenue: £1.6-6.6k/month averaged across quarters at maturity.', 'report', 'p3', '{mira,rosa}', 'to_do', NULL, 40);

-- =============================================================================
-- White-label B2B SaaS (Phase 3+)
-- =============================================================================

INSERT INTO strategy.roadmap_tasks (title, description, revenue_model, phase, agent_tags, status, completed_at, sort_order) VALUES
('Multi-tenant architecture baked into app build (15-25% extra effort)', 'Enables Phase 3 white-label without painful refactor. Same as the app build line; tagged here for visibility.', 'whitelabel', 'p2', '{mable,sasha}', 'to_do', NULL, 10),
('White-label B2B contract template prepared (Clara)', 'Standard B2B SaaS terms: licence scope, usage limits, data handling, IP, term, termination, payment, SLA.', 'whitelabel', 'p3', '{clara}', 'to_do', NULL, 20),
('First pilot partner (warm intro university / FE college / union) signed at £200-400/mo', 'Hand-rolled custom build to validate. Charlotte network + Mable execution.', 'whitelabel', 'p3', '{charlotte,mable}', 'to_do', NULL, 30),
('Productise the offering (multi-tenant self-serve onboarding, partner dashboards)', 'Mable + Sasha turn the pilot into a scalable product.', 'whitelabel', 'p3', '{mable,sasha}', 'to_do', NULL, 40),
('B2B SaaS sales agent introduced (new agent or contractor)', 'Different skill set from Rosa''s outreach. Decide at month 12 when pilot completes.', 'whitelabel', 'p3', '{charlotte}', 'to_do', NULL, 50),
('3-5 white-label partners onboarded', '£3-5k/month recurring B2B SaaS by month 18.', 'whitelabel', 'p3', '{mable}', 'to_do', NULL, 60),
('Scale to 10-15 white-label partners', '£8-15k/month recurring B2B SaaS by month 24-30.', 'whitelabel', 'p4', '{}', 'to_do', NULL, 70),
('Switchable Verified Provider badge motion (Phase 4 extension)', '£500-£2k/year per provider. Quality stamp for ITPs.', 'whitelabel', 'p4', '{rosa,nell}', 'to_do', NULL, 80);

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- TRUNCATE strategy.roadmap_tasks;
-- COMMIT;
