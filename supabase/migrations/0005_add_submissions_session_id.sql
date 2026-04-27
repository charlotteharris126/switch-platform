-- Migration 0005 — Add session_id to leads.submissions + vw_funnel_dropoff view
-- Date: 2026-04-19
-- Author: Claude (Session — partial submissions build) with owner review and Mira architectural sign-off
-- Reason: Join key from leads.submissions back to leads.partials (migration 0004).
--         Lets netlify-lead-router flip is_complete on the matching partial row
--         and enables funnel-to-conversion analytics via vw_funnel_dropoff.
-- Related:
--   platform/supabase/migrations/0004_add_leads_partials.sql (creates leads.partials)
--   platform/docs/data-architecture.md (leads.submissions + vw_funnel_dropoff)
--
-- Impact assessment (per data-infrastructure.md §8):
--   1. Change: add nullable UUID column to leads.submissions + partial index; create public.vw_funnel_dropoff.
--   2. Readers: readonly_analytics gains a new view. Existing queries on leads.submissions continue to work (column is nullable).
--   3. Writers: netlify-lead-router starts populating session_id when the form provides it. Historical rows stay NULL — intentional.
--   4. Schema_version: the lead payload contract gains one optional field (session_id). Per .claude/rules/schema-versioning.md,
--      adding an optional field is additive and does NOT require a version bump. The funded-funnel-architecture payload schema
--      (v1.0) stays at 1.0.
--   5. Data migration: none.
--   6. New role / policy: none.
--   7. Rollback: DROP VIEW, DROP INDEX, DROP COLUMN (DOWN block below). Trivial if no downstream dependencies.
--   8. Sign-off: Owner (session 2026-04-19). Mira architectural review APPROVE-WITH-CHANGES (view shipped with column per recommendation 3).

-- UP

ALTER TABLE leads.submissions
  ADD COLUMN session_id UUID;

COMMENT ON COLUMN leads.submissions.session_id IS 'Optional funnel linkage to leads.partials.session_id. NULL for submissions that arrived before partial tracking existed, or from browsers where the tracker did not run (ad blocker, JS disabled). Populated by netlify-lead-router from the session_id hidden field on the Netlify form submission.';

CREATE INDEX ON leads.submissions (session_id) WHERE session_id IS NOT NULL;

-- =====================================================================
-- VIEW — vw_funnel_dropoff
-- =====================================================================
-- Flat join of partials to their resulting submission (if any). Powers Metabase
-- drop-off dashboards and ad-performance-vs-funnel analysis. One row per session.

CREATE VIEW public.vw_funnel_dropoff
WITH (security_invoker = true) AS
SELECT
  p.session_id,
  p.form_name,
  p.course_id,
  p.funding_route,
  p.step_reached,
  p.answers,
  p.utm_source,
  p.utm_medium,
  p.utm_campaign,    -- = Meta campaign_id per the attribution convention
  p.utm_content,     -- = Meta ad_id per the attribution convention
  p.fbclid,
  p.gclid,
  p.referrer,
  p.device_type,
  p.user_agent,
  p.is_complete,
  p.first_seen_at,
  p.last_seen_at,
  s.id              AS submission_id,
  s.submitted_at,
  s.is_dq,
  s.dq_reason,
  s.primary_routed_to
FROM leads.partials p
LEFT JOIN leads.submissions s
  ON s.session_id = p.session_id;

-- readonly_analytics already has SELECT on public via the default-privileges
-- grant from 0001 (ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES).
-- That default covers views too. Explicit grant for clarity:
GRANT SELECT ON public.vw_funnel_dropoff TO readonly_analytics;

-- =====================================================================
-- VERIFICATION
-- =====================================================================

--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--     WHERE table_schema = 'leads' AND table_name = 'submissions' AND column_name = 'session_id';
--     Expected: one row, data_type = uuid, is_nullable = YES.
--
--   SELECT indexname FROM pg_indexes
--     WHERE schemaname = 'leads' AND tablename = 'submissions' AND indexname LIKE '%session%';
--     Expected: one row.
--
--   SELECT table_name FROM information_schema.views
--     WHERE table_schema = 'public' AND table_name = 'vw_funnel_dropoff';
--     Expected: one row.
--
--   Smoke test (run after Edge Function ships + first session):
--     SELECT step_reached, COUNT(*) FROM public.vw_funnel_dropoff
--       WHERE form_name = 'switchable-self-funded'
--       GROUP BY step_reached ORDER BY 1;

-- DOWN
-- DROP VIEW IF EXISTS public.vw_funnel_dropoff;
-- DROP INDEX IF EXISTS leads.submissions_session_id_idx;
-- ALTER TABLE leads.submissions DROP COLUMN IF EXISTS session_id;
