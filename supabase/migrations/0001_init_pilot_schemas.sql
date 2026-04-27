-- Migration 0001 — Initialise pilot schemas
-- Date: 2026-04-18
-- Author: Claude (platform kickoff) with owner review
-- Reason: Stand up the four pilot schemas, tables, views, roles, and RLS policies per platform/docs/data-architecture.md
-- Related: platform/docs/data-architecture.md (schema source of truth), .claude/rules/data-infrastructure.md (governance)
--
-- Before running:
--   1. Substitute the three <PASSWORD_*> placeholders at the bottom of Section E with real values from LastPass.
--      These values must match the role passwords stored in ~/Switchable/platform/.env on this device.
--   2. Run this entire file as one transaction in the Supabase SQL editor.
--   3. Verify via the verification block at the bottom of the file (Section H).
--
-- NEVER save this file with real passwords substituted. Keep placeholders in the repo copy.

-- =====================================================================
-- SECTION A — SCHEMAS
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS ads_switchable;
CREATE SCHEMA IF NOT EXISTS ads_switchleads;
CREATE SCHEMA IF NOT EXISTS leads;
CREATE SCHEMA IF NOT EXISTS crm;

COMMENT ON SCHEMA ads_switchable IS 'Switchable B2C ad performance, daily granularity, per platform';
COMMENT ON SCHEMA ads_switchleads IS 'SwitchLeads B2B ad performance (stubbed until B2B ads launch)';
COMMENT ON SCHEMA leads IS 'Form submissions, routing decisions, gateway captures, dead letter';
COMMENT ON SCHEMA crm IS 'Providers, enrolments, disputes, billing';

-- =====================================================================
-- SECTION B — TABLES (ordered by FK dependency)
-- =====================================================================

-- B1. leads.submissions (no FK dependencies)
CREATE TABLE leads.submissions (
  id                         BIGSERIAL PRIMARY KEY,
  schema_version             TEXT NOT NULL DEFAULT '1.0',
  submitted_at               TIMESTAMPTZ NOT NULL,

  -- Source (from lead payload schema)
  page_url                   TEXT,
  course_id                  TEXT,
  provider_ids               TEXT[] NOT NULL DEFAULT '{}',
  region_scheme              TEXT,
  funding_route              TEXT,

  -- Attribution
  utm_source                 TEXT,
  utm_medium                 TEXT,
  utm_campaign               TEXT,
  utm_content                TEXT,
  fbclid                     TEXT,
  gclid                      TEXT,
  referrer                   TEXT,

  -- Learner details
  first_name                 TEXT,
  last_name                  TEXT,
  email                      TEXT,
  phone                      TEXT,
  la                         TEXT,
  age_band                   TEXT,
  employment_status          TEXT,
  prior_level_3_or_higher    BOOLEAN,
  can_start_on_intake_date   BOOLEAN,
  outcome_interest           TEXT,
  why_this_course            TEXT,

  -- Consent
  terms_accepted             BOOLEAN NOT NULL DEFAULT false,
  marketing_opt_in           BOOLEAN NOT NULL DEFAULT false,

  -- Routing state (updated by n8n after routing)
  is_dq                      BOOLEAN NOT NULL DEFAULT false,
  dq_reason                  TEXT,
  primary_routed_to          TEXT,
  routed_at                  TIMESTAMPTZ,

  -- Audit
  raw_payload                JSONB NOT NULL,
  archived_at                TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- B2. leads.gateway_captures (references leads.submissions)
CREATE TABLE leads.gateway_captures (
  id              BIGSERIAL PRIMARY KEY,
  submission_id   BIGINT NOT NULL REFERENCES leads.submissions(id) ON DELETE RESTRICT,
  gateway_type    TEXT NOT NULL,
  tag             TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- B3. leads.dead_letter (references leads.submissions via replay)
CREATE TABLE leads.dead_letter (
  id                    BIGSERIAL PRIMARY KEY,
  source                TEXT NOT NULL,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload           JSONB NOT NULL,
  error_context         TEXT,
  replayed_at           TIMESTAMPTZ,
  replay_submission_id  BIGINT REFERENCES leads.submissions(id)
);

-- B4. crm.providers (no FK dependencies)
CREATE TABLE crm.providers (
  provider_id               TEXT PRIMARY KEY,
  company_name              TEXT NOT NULL,
  contact_name              TEXT,
  contact_email             TEXT NOT NULL,
  contact_phone             TEXT,
  crm_webhook_url           TEXT,

  -- Commercial
  pilot_status              TEXT NOT NULL DEFAULT 'pilot',
  pricing_model             TEXT NOT NULL,
  per_enrolment_fee         NUMERIC(10, 2),
  percent_rate              NUMERIC(5, 4),
  min_fee                   NUMERIC(10, 2),
  max_fee                   NUMERIC(10, 2),
  free_enrolments_remaining INTEGER DEFAULT 3,

  -- Lifecycle
  active                    BOOLEAN NOT NULL DEFAULT true,
  onboarded_at              TIMESTAMPTZ,
  agreement_signed_at       TIMESTAMPTZ,
  agreement_notion_page_id  TEXT,

  -- Free-text
  notes                     TEXT,

  archived_at               TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- B5. crm.provider_courses (references crm.providers)
CREATE TABLE crm.provider_courses (
  id               BIGSERIAL PRIMARY KEY,
  provider_id      TEXT NOT NULL REFERENCES crm.providers(provider_id),
  course_slug      TEXT NOT NULL,
  priority         INTEGER NOT NULL DEFAULT 1,
  monthly_capacity INTEGER,
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, course_slug)
);

-- B6. leads.routing_log (references leads.submissions and crm.providers)
CREATE TABLE leads.routing_log (
  id                BIGSERIAL PRIMARY KEY,
  submission_id     BIGINT NOT NULL REFERENCES leads.submissions(id) ON DELETE RESTRICT,
  provider_id       TEXT NOT NULL REFERENCES crm.providers(provider_id),
  routed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  route_reason      TEXT NOT NULL,
  delivery_method   TEXT NOT NULL,
  delivery_status   TEXT NOT NULL DEFAULT 'pending',
  delivered_at      TIMESTAMPTZ,
  error_message     TEXT,

  n8n_execution_id  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- B7. crm.enrolments (references leads.submissions, leads.routing_log, crm.providers)
CREATE TABLE crm.enrolments (
  id                    BIGSERIAL PRIMARY KEY,
  submission_id         BIGINT NOT NULL REFERENCES leads.submissions(id) ON DELETE RESTRICT,
  routing_log_id        BIGINT REFERENCES leads.routing_log(id),
  provider_id           TEXT NOT NULL REFERENCES crm.providers(provider_id),

  status                TEXT NOT NULL DEFAULT 'open',

  sent_to_provider_at   TIMESTAMPTZ NOT NULL,
  status_updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  presumed_deadline_at  TIMESTAMPTZ,
  dispute_deadline_at   TIMESTAMPTZ,

  -- Billing
  billed_amount         NUMERIC(10, 2),
  billed_at             TIMESTAMPTZ,
  paid_at               TIMESTAMPTZ,
  gocardless_payment_id TEXT,

  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- B8. crm.disputes (references crm.enrolments)
CREATE TABLE crm.disputes (
  id              BIGSERIAL PRIMARY KEY,
  enrolment_id    BIGINT NOT NULL REFERENCES crm.enrolments(id),
  raised_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  raised_by       TEXT NOT NULL,
  reason          TEXT NOT NULL,
  resolution      TEXT,
  resolved_at     TIMESTAMPTZ,
  resolved_by     TEXT,
  notes           TEXT
);

-- B9. ads_switchable.meta_daily (no FK dependencies)
CREATE TABLE ads_switchable.meta_daily (
  id              BIGSERIAL PRIMARY KEY,
  date            DATE NOT NULL,
  ad_account_id   TEXT NOT NULL,
  campaign_id     TEXT NOT NULL,
  campaign_name   TEXT,
  adset_id        TEXT,
  adset_name      TEXT,
  ad_id           TEXT NOT NULL,
  ad_name         TEXT,

  -- Spend and reach
  spend           NUMERIC(10, 2) NOT NULL DEFAULT 0,
  impressions     INTEGER NOT NULL DEFAULT 0,
  reach           INTEGER,
  frequency       NUMERIC(6, 3),
  clicks          INTEGER NOT NULL DEFAULT 0,

  -- Derived metrics
  ctr             NUMERIC(6, 5),
  cpc             NUMERIC(10, 2),
  cpm             NUMERIC(10, 2),

  -- Conversions
  leads           INTEGER NOT NULL DEFAULT 0,
  cost_per_lead   NUMERIC(10, 2),

  -- Segmentation
  funding_segment TEXT,

  -- Ingestion metadata
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload     JSONB,

  UNIQUE (date, ad_id)
);

-- =====================================================================
-- SECTION C — INDEXES
-- =====================================================================

-- leads.submissions
CREATE INDEX ON leads.submissions (email);
CREATE INDEX ON leads.submissions (submitted_at DESC);
CREATE INDEX ON leads.submissions (primary_routed_to);
CREATE INDEX ON leads.submissions (course_id);
CREATE INDEX ON leads.submissions (funding_route, submitted_at DESC);
CREATE INDEX ON leads.submissions (is_dq, submitted_at DESC);

-- leads.routing_log
CREATE INDEX ON leads.routing_log (submission_id);
CREATE INDEX ON leads.routing_log (provider_id, routed_at DESC);
CREATE INDEX ON leads.routing_log (delivery_status) WHERE delivery_status != 'sent';

-- leads.gateway_captures
CREATE INDEX ON leads.gateway_captures (gateway_type, created_at DESC);
CREATE INDEX ON leads.gateway_captures (submission_id);

-- leads.dead_letter
CREATE INDEX ON leads.dead_letter (replayed_at) WHERE replayed_at IS NULL;

-- crm.providers
CREATE INDEX ON crm.providers (active) WHERE archived_at IS NULL;

-- crm.provider_courses
CREATE INDEX ON crm.provider_courses (course_slug, active, priority);

-- crm.enrolments
CREATE INDEX ON crm.enrolments (provider_id, status);
CREATE INDEX ON crm.enrolments (status) WHERE status IN ('open', 'contacted', 'presumed_enrolled');
CREATE INDEX ON crm.enrolments (presumed_deadline_at) WHERE status = 'open';
CREATE INDEX ON crm.enrolments (submission_id);

-- crm.disputes
CREATE INDEX ON crm.disputes (enrolment_id);
CREATE INDEX ON crm.disputes (resolved_at) WHERE resolved_at IS NULL;

-- ads_switchable.meta_daily
CREATE INDEX ON ads_switchable.meta_daily (date);
CREATE INDEX ON ads_switchable.meta_daily (campaign_id, date);
CREATE INDEX ON ads_switchable.meta_daily (funding_segment, date);

-- =====================================================================
-- SECTION D — VIEWS
-- =====================================================================

-- vw_attribution: joins lead submissions to Meta ad performance via UTM convention
-- (utm_campaign = meta campaign_id, utm_content = meta ad_id — enforced in ad creation)
CREATE VIEW public.vw_attribution
WITH (security_invoker = true) AS
SELECT
  s.id AS submission_id,
  s.submitted_at,
  s.course_id,
  s.primary_routed_to,
  s.utm_campaign,
  s.utm_content,
  m.date AS ad_date,
  m.campaign_id,
  m.campaign_name,
  m.ad_id,
  m.ad_name,
  m.spend AS ad_daily_spend,
  m.cost_per_lead AS ad_daily_cpl
FROM leads.submissions s
LEFT JOIN ads_switchable.meta_daily m
  ON m.ad_id = s.utm_content
 AND m.date = DATE(s.submitted_at);

-- vw_weekly_kpi: one row per ISO week, powers Mira's KPI scorecard
-- Restructured to use CTEs rather than correlated subqueries so each aggregate
-- is computed independently and then joined on week_start (avoids Postgres
-- "ungrouped column in subquery" error when the outer query groups by a
-- date_trunc expression).
CREATE VIEW public.vw_weekly_kpi
WITH (security_invoker = true) AS
WITH weekly_leads AS (
  SELECT
    date_trunc('week', submitted_at) AS week_start,
    COUNT(*) AS total_submissions,
    COUNT(*) FILTER (WHERE NOT is_dq) AS qualified_leads,
    COUNT(*) FILTER (WHERE is_dq) AS dq_leads,
    COUNT(DISTINCT primary_routed_to) FILTER (WHERE primary_routed_to IS NOT NULL) AS providers_served
  FROM leads.submissions
  GROUP BY 1
),
weekly_spend AS (
  SELECT
    date_trunc('week', date) AS week_start,
    SUM(spend) AS meta_spend
  FROM ads_switchable.meta_daily
  GROUP BY 1
),
weekly_enrolments AS (
  SELECT
    date_trunc('week', sent_to_provider_at) AS week_start,
    COUNT(*) AS enrolments_this_week
  FROM crm.enrolments
  WHERE status IN ('enrolled', 'presumed_enrolled', 'billed', 'paid')
  GROUP BY 1
)
SELECT
  wl.week_start,
  wl.total_submissions,
  wl.qualified_leads,
  wl.dq_leads,
  wl.providers_served,
  ws.meta_spend,
  we.enrolments_this_week
FROM weekly_leads wl
LEFT JOIN weekly_spend ws      USING (week_start)
LEFT JOIN weekly_enrolments we USING (week_start)
ORDER BY wl.week_start DESC;

-- =====================================================================
-- SECTION E — ROLES
-- Replace the three <PASSWORD_*> placeholders with values from LastPass
-- BEFORE running this migration. Never commit real passwords back to the repo.
-- =====================================================================

CREATE ROLE readonly_analytics WITH LOGIN PASSWORD '<PASSWORD_READONLY_ANALYTICS>';
CREATE ROLE n8n_writer         WITH LOGIN PASSWORD '<PASSWORD_N8N_WRITER>';
CREATE ROLE ads_ingest         WITH LOGIN PASSWORD '<PASSWORD_ADS_INGEST>';

-- =====================================================================
-- SECTION F — GRANTS (scoped per role)
-- =====================================================================

-- readonly_analytics: USAGE on all schemas, SELECT on all tables + views
GRANT USAGE ON SCHEMA ads_switchable, ads_switchleads, leads, crm, public TO readonly_analytics;

GRANT SELECT ON ALL TABLES IN SCHEMA ads_switchable TO readonly_analytics;
GRANT SELECT ON ALL TABLES IN SCHEMA ads_switchleads TO readonly_analytics;
GRANT SELECT ON ALL TABLES IN SCHEMA leads          TO readonly_analytics;
GRANT SELECT ON ALL TABLES IN SCHEMA crm            TO readonly_analytics;
GRANT SELECT ON ALL TABLES IN SCHEMA public         TO readonly_analytics;

ALTER DEFAULT PRIVILEGES IN SCHEMA ads_switchable  GRANT SELECT ON TABLES TO readonly_analytics;
ALTER DEFAULT PRIVILEGES IN SCHEMA ads_switchleads GRANT SELECT ON TABLES TO readonly_analytics;
ALTER DEFAULT PRIVILEGES IN SCHEMA leads           GRANT SELECT ON TABLES TO readonly_analytics;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm             GRANT SELECT ON TABLES TO readonly_analytics;
ALTER DEFAULT PRIVILEGES IN SCHEMA public          GRANT SELECT ON TABLES TO readonly_analytics;

-- n8n_writer: USAGE + INSERT/UPDATE on leads.*, leads.dead_letter; SELECT on crm.providers/provider_courses; INSERT/UPDATE on crm.enrolments
GRANT USAGE ON SCHEMA leads, crm, public TO n8n_writer;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA leads TO n8n_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA leads TO n8n_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA leads GRANT SELECT, INSERT, UPDATE ON TABLES TO n8n_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA leads GRANT USAGE, SELECT ON SEQUENCES TO n8n_writer;

GRANT SELECT ON crm.providers, crm.provider_courses TO n8n_writer;
GRANT SELECT, INSERT, UPDATE ON crm.enrolments TO n8n_writer;
GRANT USAGE, SELECT ON SEQUENCE crm.enrolments_id_seq TO n8n_writer;

-- ads_ingest: USAGE + INSERT/UPDATE on ads_* schemas
GRANT USAGE ON SCHEMA ads_switchable, ads_switchleads TO ads_ingest;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ads_switchable  TO ads_ingest;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ads_switchleads TO ads_ingest;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ads_switchable  TO ads_ingest;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ads_switchleads TO ads_ingest;
ALTER DEFAULT PRIVILEGES IN SCHEMA ads_switchable  GRANT SELECT, INSERT, UPDATE ON TABLES TO ads_ingest;
ALTER DEFAULT PRIVILEGES IN SCHEMA ads_switchleads GRANT SELECT, INSERT, UPDATE ON TABLES TO ads_ingest;
ALTER DEFAULT PRIVILEGES IN SCHEMA ads_switchable  GRANT USAGE, SELECT ON SEQUENCES TO ads_ingest;
ALTER DEFAULT PRIVILEGES IN SCHEMA ads_switchleads GRANT USAGE, SELECT ON SEQUENCES TO ads_ingest;

-- =====================================================================
-- SECTION G — ROW LEVEL SECURITY
-- Enable RLS on every table + explicit policies per role.
-- Tables with RLS enabled and no policies deny all access (except superuser).
-- =====================================================================

-- Enable RLS
ALTER TABLE leads.submissions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads.routing_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads.gateway_captures     ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads.dead_letter          ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.providers              ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.provider_courses       ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.enrolments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.disputes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_switchable.meta_daily  ENABLE ROW LEVEL SECURITY;

-- readonly_analytics: SELECT on all tables
CREATE POLICY analytics_read_submissions        ON leads.submissions          FOR SELECT TO readonly_analytics USING (true);
CREATE POLICY analytics_read_routing_log        ON leads.routing_log          FOR SELECT TO readonly_analytics USING (true);
CREATE POLICY analytics_read_gateway_captures   ON leads.gateway_captures     FOR SELECT TO readonly_analytics USING (true);
CREATE POLICY analytics_read_dead_letter        ON leads.dead_letter          FOR SELECT TO readonly_analytics USING (true);
CREATE POLICY analytics_read_providers          ON crm.providers              FOR SELECT TO readonly_analytics USING (true);
CREATE POLICY analytics_read_provider_courses   ON crm.provider_courses       FOR SELECT TO readonly_analytics USING (true);
CREATE POLICY analytics_read_enrolments         ON crm.enrolments             FOR SELECT TO readonly_analytics USING (true);
CREATE POLICY analytics_read_disputes           ON crm.disputes               FOR SELECT TO readonly_analytics USING (true);
CREATE POLICY analytics_read_meta_daily         ON ads_switchable.meta_daily  FOR SELECT TO readonly_analytics USING (true);

-- n8n_writer: full access to leads.*, INSERT/UPDATE on crm.enrolments, SELECT on crm.providers/provider_courses
CREATE POLICY n8n_all_submissions        ON leads.submissions        FOR ALL    TO n8n_writer USING (true) WITH CHECK (true);
CREATE POLICY n8n_all_routing_log        ON leads.routing_log        FOR ALL    TO n8n_writer USING (true) WITH CHECK (true);
CREATE POLICY n8n_all_gateway_captures   ON leads.gateway_captures   FOR ALL    TO n8n_writer USING (true) WITH CHECK (true);
CREATE POLICY n8n_all_dead_letter        ON leads.dead_letter        FOR ALL    TO n8n_writer USING (true) WITH CHECK (true);
CREATE POLICY n8n_select_providers       ON crm.providers            FOR SELECT TO n8n_writer USING (true);
CREATE POLICY n8n_select_provider_courses ON crm.provider_courses    FOR SELECT TO n8n_writer USING (true);
CREATE POLICY n8n_write_enrolments       ON crm.enrolments           FOR ALL    TO n8n_writer USING (true) WITH CHECK (true);

-- ads_ingest: full access to ads_switchable.*, ads_switchleads.*
CREATE POLICY ads_ingest_meta_daily ON ads_switchable.meta_daily FOR ALL TO ads_ingest USING (true) WITH CHECK (true);

-- =====================================================================
-- SECTION H — VERIFICATION (run as separate statements after migration)
-- =====================================================================

-- Expected counts after running this migration:
--   4 schemas (ads_switchable, ads_switchleads, leads, crm)
--   9 tables across 4 schemas
--   2 views (public.vw_attribution, public.vw_weekly_kpi)
--   3 new roles (readonly_analytics, n8n_writer, ads_ingest)
--   RLS enabled on 9 tables, with 17 policies total

-- Uncomment to verify:
-- SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('ads_switchable','ads_switchleads','leads','crm');
-- SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('ads_switchable','ads_switchleads','leads','crm') ORDER BY 1,2;
-- SELECT table_schema, table_name FROM information_schema.views WHERE table_schema = 'public';
-- SELECT rolname FROM pg_roles WHERE rolname IN ('readonly_analytics','n8n_writer','ads_ingest');
-- SELECT schemaname, tablename, rowsecurity FROM pg_tables WHERE schemaname IN ('ads_switchable','leads','crm');
-- SELECT schemaname, tablename, policyname, roles FROM pg_policies ORDER BY 1,2,3;

-- =====================================================================
-- DOWN (reverse of UP, for reference only)
-- Do not run unless intentionally rolling back.
-- =====================================================================

-- DROP POLICY IF EXISTS analytics_read_submissions       ON leads.submissions;
-- DROP POLICY IF EXISTS analytics_read_routing_log       ON leads.routing_log;
-- DROP POLICY IF EXISTS analytics_read_gateway_captures  ON leads.gateway_captures;
-- DROP POLICY IF EXISTS analytics_read_dead_letter       ON leads.dead_letter;
-- DROP POLICY IF EXISTS analytics_read_providers         ON crm.providers;
-- DROP POLICY IF EXISTS analytics_read_provider_courses  ON crm.provider_courses;
-- DROP POLICY IF EXISTS analytics_read_enrolments        ON crm.enrolments;
-- DROP POLICY IF EXISTS analytics_read_disputes          ON crm.disputes;
-- DROP POLICY IF EXISTS analytics_read_meta_daily        ON ads_switchable.meta_daily;
-- DROP POLICY IF EXISTS n8n_all_submissions              ON leads.submissions;
-- DROP POLICY IF EXISTS n8n_all_routing_log              ON leads.routing_log;
-- DROP POLICY IF EXISTS n8n_all_gateway_captures         ON leads.gateway_captures;
-- DROP POLICY IF EXISTS n8n_all_dead_letter              ON leads.dead_letter;
-- DROP POLICY IF EXISTS n8n_select_providers             ON crm.providers;
-- DROP POLICY IF EXISTS n8n_select_provider_courses      ON crm.provider_courses;
-- DROP POLICY IF EXISTS n8n_write_enrolments             ON crm.enrolments;
-- DROP POLICY IF EXISTS ads_ingest_meta_daily            ON ads_switchable.meta_daily;
-- DROP VIEW IF EXISTS public.vw_weekly_kpi;
-- DROP VIEW IF EXISTS public.vw_attribution;
-- DROP ROLE IF EXISTS readonly_analytics;
-- DROP ROLE IF EXISTS n8n_writer;
-- DROP ROLE IF EXISTS ads_ingest;
-- DROP SCHEMA IF EXISTS ads_switchable  CASCADE;
-- DROP SCHEMA IF EXISTS ads_switchleads CASCADE;
-- DROP SCHEMA IF EXISTS leads           CASCADE;
-- DROP SCHEMA IF EXISTS crm             CASCADE;
