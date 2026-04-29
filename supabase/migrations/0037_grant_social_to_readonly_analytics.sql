-- Migration 0037 — grant social schema read access to readonly_analytics
-- Date: 2026-04-29
-- Author: Claude (platform session) with owner sign-off in handoff order
-- Reason: Thea's Postgres MCP reads (and Mira's, Sasha's) need access to
-- social.* for weekly reporting, analytics queries, and the social
-- module's analytics surface. Migration 0029 only granted USAGE +
-- table privileges to authenticated; readonly_analytics was missed,
-- causing every MCP query against social.* to fail with
-- "permission denied for schema social".
--
-- Sensitive tables EXCLUDED:
--   - social.oauth_tokens (contains LinkedIn refresh tokens)
--   - social.push_subscriptions (per-user push endpoint URLs)
-- Both stay locked to authenticated/admin.
--
-- Pattern follows migration 0016 (audit + crm.routing_config grants):
-- USAGE on schema + SELECT on tables + a SELECT-only RLS policy per
-- table for readonly_analytics. Without the policy, the existing
-- "FOR ALL TO authenticated" policies block readonly_analytics reads.
--
-- Related: switchleads/social/CLAUDE.md (Thea's MCP scope),
-- platform/CLAUDE.md (Sasha's read-only role),
-- migration 0029 (social schema), migration 0016 (precedent).

-- UP

GRANT USAGE ON SCHEMA social TO readonly_analytics;

-- Table-level SELECT grants (sensitive tables omitted).
GRANT SELECT ON social.drafts             TO readonly_analytics;
GRANT SELECT ON social.engagement_targets TO readonly_analytics;
GRANT SELECT ON social.engagement_queue   TO readonly_analytics;
GRANT SELECT ON social.post_analytics     TO readonly_analytics;
GRANT SELECT ON social.engagement_log     TO readonly_analytics;

-- View-level SELECT grants. Views are separate objects from their
-- backing tables; missing grants here surface as "permission denied
-- for view" even when the backing tables are reachable.
GRANT SELECT ON social.vw_pending_drafts          TO readonly_analytics;
GRANT SELECT ON social.vw_post_performance        TO readonly_analytics;
GRANT SELECT ON social.vw_engagement_queue_active TO readonly_analytics;
GRANT SELECT ON social.vw_targets_due_review      TO readonly_analytics;
GRANT SELECT ON social.vw_rejection_patterns      TO readonly_analytics;
GRANT SELECT ON social.vw_channel_status          TO readonly_analytics;

-- RLS: each table has FOR ALL TO authenticated using admin.is_admin().
-- That policy does not match the readonly_analytics role, so without
-- a parallel SELECT-only policy the role would be blocked at the row
-- filter even after the GRANT.
DROP POLICY IF EXISTS readonly_select_drafts             ON social.drafts;
DROP POLICY IF EXISTS readonly_select_engagement_targets ON social.engagement_targets;
DROP POLICY IF EXISTS readonly_select_engagement_queue   ON social.engagement_queue;
DROP POLICY IF EXISTS readonly_select_post_analytics     ON social.post_analytics;
DROP POLICY IF EXISTS readonly_select_engagement_log     ON social.engagement_log;

CREATE POLICY readonly_select_drafts ON social.drafts
  FOR SELECT TO readonly_analytics USING (true);

CREATE POLICY readonly_select_engagement_targets ON social.engagement_targets
  FOR SELECT TO readonly_analytics USING (true);

CREATE POLICY readonly_select_engagement_queue ON social.engagement_queue
  FOR SELECT TO readonly_analytics USING (true);

CREATE POLICY readonly_select_post_analytics ON social.post_analytics
  FOR SELECT TO readonly_analytics USING (true);

CREATE POLICY readonly_select_engagement_log ON social.engagement_log
  FOR SELECT TO readonly_analytics USING (true);

-- DOWN
-- DROP POLICY IF EXISTS readonly_select_drafts             ON social.drafts;
-- DROP POLICY IF EXISTS readonly_select_engagement_targets ON social.engagement_targets;
-- DROP POLICY IF EXISTS readonly_select_engagement_queue   ON social.engagement_queue;
-- DROP POLICY IF EXISTS readonly_select_post_analytics     ON social.post_analytics;
-- DROP POLICY IF EXISTS readonly_select_engagement_log     ON social.engagement_log;
-- REVOKE SELECT ON ALL TABLES IN SCHEMA social FROM readonly_analytics;
-- REVOKE USAGE ON SCHEMA social FROM readonly_analytics;
