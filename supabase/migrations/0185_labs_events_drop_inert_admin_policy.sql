-- Migration 0185 — drop the inert admin read policy on labs.events
-- Date: 2026-06-03
-- Author: Claude (Labs session) with owner review
-- Reason: 0184 added admin_read_labs_events (authenticated + admin.is_admin())
--   "for parity" with leads.submissions, but never granted `authenticated` USAGE
--   on schema labs or SELECT on labs.events, and the labs schema is deliberately
--   not exposed to the data API. So the policy can never fire — it's dead, and the
--   "parity" framing was misleading. The chosen design (Option B, 2026-06-03) is
--   that labs.events stays off the API entirely and is read only by service-role
--   RPCs (0183) behind the admin login. Removing the dead policy makes the design
--   honest and means a future accidental schema exposure fails closed (no policy =
--   deny by default under RLS). If labs is ever intentionally exposed, the admin
--   read policy + matching grants get added together, deliberately, at that point.
--
-- Impact: none functional. The policy never granted access (no table GRANT to
--   authenticated, schema not API-exposed). Admin page reads via service-role RPCs
--   (unaffected). readonly_analytics reads labs.events_analytics (unaffected).
-- Related: 0184_labs_events_pii_minimisation.sql, platform/docs/data-architecture.md

-- UP
DROP POLICY IF EXISTS admin_read_labs_events ON labs.events;

-- DOWN
-- CREATE POLICY admin_read_labs_events ON labs.events
--   FOR SELECT TO authenticated USING (admin.is_admin());
