-- Migration 0181 — Switchable Labs funnel events
-- Date: 2026-06-03
-- Author: Claude (Labs session) with owner review
-- Reason: Durable conversion tracking for the Switchable Labs smoke-test tools
--   (Am I Stuck? /amistuck, Gaply /gaply). Replaces reliance on Netlify Forms
--   (free tier ~100 submissions/month, silently drops data under ad traffic).
--   One row per funnel event so cost-per-email is measurable and joins to ad spend.
--   Netlify Forms is KEPT in parallel as the email list of record (sell/nurture later).
-- Related: labs/docs/current-handoff.md, strategy/docs/switchable-labs-success-model.md
-- Ingested by: Edge Function `labs-event` (browser POST), via functions_writer.
-- Read by: readonly_analytics (agents / Metabase).

-- UP
CREATE SCHEMA IF NOT EXISTS labs;

CREATE TABLE labs.events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at     timestamptz NOT NULL DEFAULT now(),
  tool           text NOT NULL CHECK (tool IN ('amistuck', 'gaply')),
  event          text NOT NULL CHECK (event IN ('run', 'unlock_intent', 'signup')),
  session_id     text,                          -- per-browser id, links run -> unlock_intent -> signup
  email          text,                          -- signup only (PII, consented capture)
  payload        jsonb NOT NULL DEFAULT '{}',   -- tool inputs: town/job, interests, skills, prefs, result count
  attribution    jsonb NOT NULL DEFAULT '{}',   -- utm_*, fbclid, gclid from the landing URL
  referrer       text,
  user_agent     text,
  is_bot         boolean NOT NULL DEFAULT false,
  schema_version text NOT NULL DEFAULT '1.0'
);

CREATE INDEX labs_events_tool_event_created_idx ON labs.events (tool, event, created_at);
CREATE INDEX labs_events_session_idx ON labs.events (session_id);
CREATE INDEX labs_events_email_idx ON labs.events (email) WHERE email IS NOT NULL;

-- RLS: deny by default, explicit grants below. (Postgres evaluates GRANT before RLS,
-- so each policy needs a matching table GRANT — see .claude/rules/data-infrastructure.md
-- and the RLS-needs-GRANT lesson from migrations 0096/0108/0109.)
ALTER TABLE labs.events ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA labs TO functions_writer, readonly_analytics;
GRANT INSERT ON labs.events TO functions_writer;
GRANT SELECT ON labs.events TO readonly_analytics;

CREATE POLICY labs_events_insert_writer ON labs.events
  FOR INSERT TO functions_writer WITH CHECK (true);
CREATE POLICY labs_events_select_ro ON labs.events
  FOR SELECT TO readonly_analytics USING (true);

-- DOWN
-- DROP POLICY IF EXISTS labs_events_select_ro ON labs.events;
-- DROP POLICY IF EXISTS labs_events_insert_writer ON labs.events;
-- DROP TABLE IF EXISTS labs.events;
-- DROP SCHEMA IF EXISTS labs;   -- only if no other labs.* objects exist
