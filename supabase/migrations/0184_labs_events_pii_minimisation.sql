-- Migration 0184 — keep raw PII out of the reporting role for labs.events
-- Date: 2026-06-03
-- Author: Claude (Labs session) with owner review
-- Reason: labs.events holds signup emails (direct identifier). 0181 granted the
--   reporting role (readonly_analytics, used by the agents over the Postgres MCP)
--   full SELECT including email. The agents only need counts/segments, never the
--   raw email. Establishes the platform PII-for-reporting standard (see
--   .claude/rules/data-infrastructure.md §6a): operational roles (admin via login,
--   functions_writer) may read raw PII; the reporting role reads a PII-free view.
--   Also adds the admin.is_admin() read parity policy that leads.submissions has.
--
-- Impact assessment:
--   - Changes: readonly_analytics loses raw SELECT on labs.events (incl email),
--     gains SELECT on new email-free view labs.events_analytics. New admin read
--     policy on labs.events (parity with leads.submissions).
--   - Reads of labs.events today: the admin page reads via SECURITY DEFINER RPCs
--     as service_role (migration 0183, unaffected). No agent/analytics consumer
--     reads it yet (table is days old, only a bot test row). Breakage risk: none.
--   - Writes: functions_writer via the labs-event EF (unaffected).
--   - schema_version: unchanged (no change to the ingest contract).
--   - Rollback: in DOWN.
--   - Sign-off: Owner (2026-06-03).
-- Related: 0181_labs_events.sql, 0183_labs_admin_rpcs.sql,
--   platform/docs/data-architecture.md, .claude/rules/data-infrastructure.md

-- UP

-- 1. Reporting role: drop raw read of the PII table.
DROP POLICY IF EXISTS labs_events_select_ro ON labs.events;
REVOKE SELECT ON labs.events FROM readonly_analytics;

-- 2. Reporting role: email-free view of the same data. Runs as owner (postgres),
--    so it can read the underlying table the role no longer has direct access to.
--    Excludes email (the only direct identifier). If a future Labs tool ever
--    writes a name or other identifier into payload, revisit this view.
CREATE VIEW labs.events_analytics AS
  SELECT
    id,
    created_at,
    tool,
    event,
    session_id,
    payload,
    attribution,
    referrer,
    user_agent,
    is_bot,
    schema_version
  FROM labs.events;

GRANT SELECT ON labs.events_analytics TO readonly_analytics;

-- 3. Admin read parity with leads.submissions (admin_read_submissions). Lets a
--    logged-in admin read raw rows if the schema is ever exposed to the API;
--    harmless today (labs is not exposed; the admin page reads via service-role
--    RPCs). Keeps the access model identical to the rest of the platform.
CREATE POLICY admin_read_labs_events ON labs.events
  FOR SELECT TO authenticated USING (admin.is_admin());

-- DOWN
-- DROP POLICY IF EXISTS admin_read_labs_events ON labs.events;
-- REVOKE SELECT ON labs.events_analytics FROM readonly_analytics;
-- DROP VIEW IF EXISTS labs.events_analytics;
-- GRANT SELECT ON labs.events TO readonly_analytics;
-- CREATE POLICY labs_events_select_ro ON labs.events
--   FOR SELECT TO readonly_analytics USING (true);
