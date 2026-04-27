-- Migration 0016 — Session C schema additions for admin dashboard write surfaces
-- Date: 2026-04-24
-- Author: Claude (platform Session C) with owner review
-- Reason: Prepare the database for Session D (write surfaces — routing UI, enrolment
--         outcome management, provider edit, error replay) and Session F (GDPR erase).
--         All additive: new columns with safe defaults, new tables, new views. No
--         existing data touched beyond the first_lead_received_at backfill.
--
--         Also includes a catch-up for migration 0013 (audit.actions) — the Session A
--         handoff recorded 0013 as applied, but a Session C pre-flight check found
--         audit.actions missing in production. This migration creates it idempotently
--         so the dashboard write surface has a working audit sink from day one.
--
-- Related: platform/docs/admin-dashboard-scoping.md § Session C,
--          .claude/rules/data-infrastructure.md (schema change discipline),
--          .claude/rules/schema-versioning.md (additive vs breaking change rules).

-- UP

-- =============================================================================
-- 0. audit.actions — catch-up from migration 0013
-- =============================================================================
-- Idempotent: CREATE IF NOT EXISTS so re-running after 0013 finally applies is safe.

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.actions (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_email     TEXT NOT NULL,
  surface         TEXT NOT NULL CHECK (surface IN ('admin', 'provider', 'system')),
  action          TEXT NOT NULL,
  target_table    TEXT,
  target_id       TEXT,
  before_value    JSONB,
  after_value     JSONB,
  context         JSONB,
  ip_address      INET,
  user_agent      TEXT
);

CREATE INDEX IF NOT EXISTS audit_actions_created_at_idx   ON audit.actions (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_actions_actor_user_id_idx ON audit.actions (actor_user_id);
CREATE INDEX IF NOT EXISTS audit_actions_target_idx       ON audit.actions (target_table, target_id);
CREATE INDEX IF NOT EXISTS audit_actions_action_idx       ON audit.actions (action);

ALTER TABLE audit.actions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'audit' AND tablename = 'actions' AND policyname = 'audit_actions_readonly_select'
  ) THEN
    CREATE POLICY "audit_actions_readonly_select"
      ON audit.actions FOR SELECT TO readonly_analytics USING (true);
  END IF;
END $$;

COMMENT ON TABLE audit.actions IS 'Tamper-evident log of every write performed via the admin dashboard. Append-only — never UPDATE or DELETE rows here.';


-- =============================================================================
-- 1. crm.providers — new columns
-- =============================================================================

-- Anchor for the "newness boost" in future auto-routing. Backfilled from routing_log
-- so existing pilot providers get a real date rather than NULL.
ALTER TABLE crm.providers
  ADD COLUMN IF NOT EXISTS first_lead_received_at TIMESTAMPTZ;

UPDATE crm.providers p
SET first_lead_received_at = subq.earliest
FROM (
  SELECT provider_id, MIN(routed_at) AS earliest
  FROM leads.routing_log
  GROUP BY provider_id
) subq
WHERE p.provider_id = subq.provider_id
  AND p.first_lead_received_at IS NULL;

-- Per-provider opt-in for future auto-routing. Default false (manual today).
ALTER TABLE crm.providers
  ADD COLUMN IF NOT EXISTS auto_route_enabled BOOLEAN NOT NULL DEFAULT false;

-- Billing model enum with a safe default matching today's pilot behaviour. The
-- credits path is dormant until a credits-model provider signs.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_model') THEN
    CREATE TYPE crm.billing_model AS ENUM (
      'retrospective_per_enrolment',  -- current pilot: invoice after enrolment confirmed
      'prepaid_credits',              -- future: provider buys credits upfront
      'per_lead'                      -- future: pay per qualified lead (marketplace model)
    );
  END IF;
END $$;

ALTER TABLE crm.providers
  ADD COLUMN IF NOT EXISTS billing_model crm.billing_model NOT NULL DEFAULT 'retrospective_per_enrolment';


-- =============================================================================
-- 2. crm.routing_config — global routing knobs
-- =============================================================================
-- Single-row table (enforced by a unique constant key). Holds flags like
-- "monitor vs auto-route" plus tunable weights for future scoring.

CREATE TABLE IF NOT EXISTS crm.routing_config (
  id                    TEXT PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
  mode                  TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual', 'monitor', 'auto')),
  -- Future scoring weights (dormant until auto-routing ships)
  weight_enrolment_rate NUMERIC NOT NULL DEFAULT 0.5,
  weight_deadline       NUMERIC NOT NULL DEFAULT 0.3,
  weight_newness        NUMERIC NOT NULL DEFAULT 0.2,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

INSERT INTO crm.routing_config (id) VALUES ('singleton') ON CONFLICT DO NOTHING;

ALTER TABLE crm.routing_config ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'crm' AND tablename = 'routing_config' AND policyname = 'admin_read_routing_config'
  ) THEN
    CREATE POLICY admin_read_routing_config ON crm.routing_config
      FOR SELECT TO authenticated USING (admin.is_admin());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'crm' AND tablename = 'routing_config' AND policyname = 'analytics_read_routing_config'
  ) THEN
    CREATE POLICY analytics_read_routing_config ON crm.routing_config
      FOR SELECT TO readonly_analytics USING (true);
  END IF;
END $$;

GRANT SELECT ON crm.routing_config TO authenticated;
GRANT SELECT ON crm.routing_config TO readonly_analytics;


-- =============================================================================
-- 3. crm.provider_credits — dormant until first credits-model provider
-- =============================================================================

CREATE TABLE IF NOT EXISTS crm.provider_credits (
  id              BIGSERIAL PRIMARY KEY,
  provider_id     TEXT NOT NULL REFERENCES crm.providers(provider_id) ON DELETE RESTRICT,
  balance         NUMERIC NOT NULL DEFAULT 0,  -- credits, not £; conversion rate held in routing_config later
  last_topup_at   TIMESTAMPTZ,
  last_spent_at   TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id)
);

ALTER TABLE crm.provider_credits ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'crm' AND tablename = 'provider_credits' AND policyname = 'admin_read_provider_credits'
  ) THEN
    CREATE POLICY admin_read_provider_credits ON crm.provider_credits
      FOR SELECT TO authenticated USING (admin.is_admin());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'crm' AND tablename = 'provider_credits' AND policyname = 'analytics_read_provider_credits'
  ) THEN
    CREATE POLICY analytics_read_provider_credits ON crm.provider_credits
      FOR SELECT TO readonly_analytics USING (true);
  END IF;
END $$;

GRANT SELECT ON crm.provider_credits TO authenticated;
GRANT SELECT ON crm.provider_credits TO readonly_analytics;


-- =============================================================================
-- 4. crm.billing_events — model-agnostic billable event log
-- =============================================================================
-- One row per billable event. Billing model determines how events become
-- invoices. Schema supports per-enrolment (today), per-lead (future marketplace),
-- and credit-debit (future credits model) without rework.

CREATE TABLE IF NOT EXISTS crm.billing_events (
  id                BIGSERIAL PRIMARY KEY,
  provider_id       TEXT NOT NULL REFERENCES crm.providers(provider_id) ON DELETE RESTRICT,
  event_type        TEXT NOT NULL CHECK (event_type IN (
                      'enrolment_confirmed',
                      'lead_delivered',
                      'credit_debit',
                      'credit_topup',
                      'manual_adjustment'
                    )),
  amount_gbp        NUMERIC,                     -- NULL for credit events (use amount_credits)
  amount_credits    NUMERIC,                     -- NULL for cash events
  enrolment_id      BIGINT REFERENCES crm.enrolments(id) ON DELETE SET NULL,
  submission_id     BIGINT REFERENCES leads.submissions(id) ON DELETE SET NULL,
  description       TEXT,
  invoiced_at       TIMESTAMPTZ,
  invoice_reference TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS billing_events_provider_id_idx    ON crm.billing_events (provider_id);
CREATE INDEX IF NOT EXISTS billing_events_created_at_idx     ON crm.billing_events (created_at DESC);
CREATE INDEX IF NOT EXISTS billing_events_invoiced_at_idx    ON crm.billing_events (invoiced_at);

ALTER TABLE crm.billing_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'crm' AND tablename = 'billing_events' AND policyname = 'admin_read_billing_events'
  ) THEN
    CREATE POLICY admin_read_billing_events ON crm.billing_events
      FOR SELECT TO authenticated USING (admin.is_admin());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'crm' AND tablename = 'billing_events' AND policyname = 'analytics_read_billing_events'
  ) THEN
    CREATE POLICY analytics_read_billing_events ON crm.billing_events
      FOR SELECT TO readonly_analytics USING (true);
  END IF;
END $$;

GRANT SELECT ON crm.billing_events TO authenticated;
GRANT SELECT ON crm.billing_events TO readonly_analytics;


-- =============================================================================
-- 5. audit.erasure_requests — GDPR right-to-erasure log (used by Session F)
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit.erasure_requests (
  id                   BIGSERIAL PRIMARY KEY,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  requester_email      TEXT NOT NULL,
  identity_verified_at TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                        'pending', 'verifying', 'in_progress', 'completed', 'rejected'
                      )),
  rejection_reason     TEXT,
  -- Per-system erasure results (one JSONB object per system so we keep a receipt)
  supabase_result      JSONB,
  brevo_result         JSONB,
  netlify_result       JSONB,
  meta_capi_result     JSONB,
  google_ads_result    JSONB,
  completed_at         TIMESTAMPTZ,
  processed_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  notes                TEXT
);

CREATE INDEX IF NOT EXISTS erasure_requests_status_idx      ON audit.erasure_requests (status);
CREATE INDEX IF NOT EXISTS erasure_requests_received_at_idx ON audit.erasure_requests (received_at DESC);
CREATE INDEX IF NOT EXISTS erasure_requests_email_idx       ON audit.erasure_requests (requester_email);

ALTER TABLE audit.erasure_requests ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'audit' AND tablename = 'erasure_requests' AND policyname = 'admin_read_erasure_requests'
  ) THEN
    CREATE POLICY admin_read_erasure_requests ON audit.erasure_requests
      FOR SELECT TO authenticated USING (admin.is_admin());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'audit' AND tablename = 'erasure_requests' AND policyname = 'analytics_read_erasure_requests'
  ) THEN
    CREATE POLICY analytics_read_erasure_requests ON audit.erasure_requests
      FOR SELECT TO readonly_analytics USING (true);
  END IF;
END $$;

GRANT USAGE ON SCHEMA audit TO authenticated, readonly_analytics;
GRANT SELECT ON audit.erasure_requests TO authenticated;
GRANT SELECT ON audit.erasure_requests TO readonly_analytics;
GRANT SELECT ON audit.actions TO readonly_analytics;


-- =============================================================================
-- 6. Views: performance, needs-status-update, admin-health
-- =============================================================================

-- 6.1 vw_provider_performance — rolling 30-day enrolment ratio per provider.
-- Feeds future auto-routing + Session E health bar comparisons.
CREATE OR REPLACE VIEW crm.vw_provider_performance
  WITH (security_invoker = true) AS
WITH windowed AS (
  SELECT
    p.provider_id,
    p.company_name,
    -- Leads sent in last 30 days
    (
      SELECT COUNT(*)::int
      FROM leads.routing_log rl
      WHERE rl.provider_id = p.provider_id
        AND rl.routed_at > now() - INTERVAL '30 days'
    ) AS leads_30d,
    -- Confirmed enrolments in last 30 days
    (
      SELECT COUNT(*)::int
      FROM crm.enrolments e
      WHERE e.provider_id = p.provider_id
        AND e.status = 'enrolled'
        AND e.status_updated_at > now() - INTERVAL '30 days'
    ) AS enrolments_30d
  FROM crm.providers p
  WHERE p.active = true
    AND p.archived_at IS NULL
)
SELECT
  provider_id,
  company_name,
  leads_30d,
  enrolments_30d,
  CASE WHEN leads_30d = 0 THEN NULL
       ELSE ROUND(enrolments_30d::numeric / leads_30d, 4)
  END AS enrolment_rate_30d
FROM windowed;

-- 6.2 vw_needs_status_update — routed leads stale for >14 days without enrolment outcome.
-- Feeds Session D's "needs attention" panel. Uses NOT EXISTS over crm.enrolments so rows
-- that have any non-open enrolment disappear from the panel.
CREATE OR REPLACE VIEW leads.vw_needs_status_update
  WITH (security_invoker = true) AS
SELECT
  s.id                  AS submission_id,
  s.primary_routed_to   AS provider_id,
  s.first_name,
  s.last_name,
  s.email,
  s.course_id,
  s.routed_at,
  (now() - s.routed_at) AS routed_age,
  p.company_name        AS provider_name
FROM leads.submissions s
LEFT JOIN crm.providers p ON p.provider_id = s.primary_routed_to
WHERE s.primary_routed_to IS NOT NULL
  AND s.is_dq = false
  AND s.archived_at IS NULL
  AND s.routed_at < now() - INTERVAL '14 days'
  AND NOT EXISTS (
    SELECT 1 FROM crm.enrolments e
    WHERE e.submission_id = s.id
      AND e.status IN ('enrolled', 'not_enrolled', 'disputed', 'presumed_enrolled')
  )
ORDER BY s.routed_at ASC;

-- 6.3 vw_admin_health — one-row snapshot of the health bar counters.
-- Aggregates live counts for the Session E topbar + on-demand audit button.
CREATE OR REPLACE VIEW public.vw_admin_health
  WITH (security_invoker = true) AS
SELECT
  (SELECT COUNT(*)::int FROM leads.submissions WHERE submitted_at > now() - INTERVAL '7 days')        AS leads_last_7d,
  (SELECT COUNT(*)::int FROM leads.submissions
    WHERE primary_routed_to IS NULL AND is_dq = false AND submitted_at < now() - INTERVAL '48 hours') AS unrouted_over_48h,
  (SELECT COUNT(*)::int FROM leads.dead_letter
    WHERE replayed_at IS NULL AND received_at < now() - INTERVAL '7 days')                           AS errors_over_7d,
  (SELECT COUNT(*)::int FROM leads.dead_letter WHERE replayed_at IS NULL)                            AS errors_unresolved_total,
  (SELECT COUNT(*)::int FROM leads.vw_needs_status_update)                                           AS needs_status_update_count;

-- Grant view access. RLS on the underlying tables still gates content.
GRANT SELECT ON crm.vw_provider_performance TO authenticated, readonly_analytics;
GRANT SELECT ON leads.vw_needs_status_update TO authenticated, readonly_analytics;
GRANT SELECT ON public.vw_admin_health TO authenticated, readonly_analytics;


-- DOWN
-- -- 6. Views
-- DROP VIEW IF EXISTS public.vw_admin_health;
-- DROP VIEW IF EXISTS leads.vw_needs_status_update;
-- DROP VIEW IF EXISTS crm.vw_provider_performance;
-- -- 5. audit.erasure_requests
-- DROP TABLE IF EXISTS audit.erasure_requests;
-- -- 4. crm.billing_events
-- DROP TABLE IF EXISTS crm.billing_events;
-- -- 3. crm.provider_credits
-- DROP TABLE IF EXISTS crm.provider_credits;
-- -- 2. crm.routing_config
-- DROP TABLE IF EXISTS crm.routing_config;
-- -- 1. crm.providers columns
-- ALTER TABLE crm.providers DROP COLUMN IF EXISTS billing_model;
-- DROP TYPE IF EXISTS crm.billing_model;
-- ALTER TABLE crm.providers DROP COLUMN IF EXISTS auto_route_enabled;
-- ALTER TABLE crm.providers DROP COLUMN IF EXISTS first_lead_received_at;
-- -- 0. audit.actions (only drop if not previously applied by 0013)
-- -- DROP TABLE IF EXISTS audit.actions;
-- -- DROP SCHEMA IF EXISTS audit;
