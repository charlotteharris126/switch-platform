-- Migration 0006 — grant readonly_analytics read access to cron schema
-- Date: 2026-04-19
-- Author: Claude (Session 2.5, post-incident) with owner review
-- Reason: Sasha's Monday scan is supposed to verify cron.job presence and
-- recent run history (per platform/CLAUDE.md "Automation health" section),
-- but readonly_analytics had no access to the cron schema — resulting in a
-- silent governance gap. Today's webhook-disabled incident exposed this:
-- the daily audit cron had never actually been scheduled, and Sasha had
-- no way to detect that even once she started running. This migration
-- gives readonly_analytics SELECT on the cron metadata tables so Sasha,
-- Mira, and any future agent can verify schedule presence and run history.
-- Related: platform/docs/changelog.md 2026-04-19 incident entry;
-- platform/docs/infrastructure-manifest.md.

-- UP
GRANT USAGE ON SCHEMA cron TO readonly_analytics;
GRANT SELECT ON cron.job TO readonly_analytics;
GRANT SELECT ON cron.job_run_details TO readonly_analytics;

-- Notes:
-- 1. Supabase Cron stores all scheduled jobs in cron.job (whether created via
--    the dashboard UI as HTTP Request jobs or via SQL via cron.schedule()).
--    Both produce rows in cron.job; read access here sees all of them.
-- 2. cron.job_run_details logs each invocation — useful for detecting failed
--    runs without having to open the dashboard.
-- 3. This is additive and reversible. No data is exposed that a postgres user
--    couldn't already read; we're just extending the same read scope to the
--    scoped analytics role.

-- DOWN
-- REVOKE SELECT ON cron.job_run_details FROM readonly_analytics;
-- REVOKE SELECT ON cron.job FROM readonly_analytics;
-- REVOKE USAGE ON SCHEMA cron FROM readonly_analytics;
