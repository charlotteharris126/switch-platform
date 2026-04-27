-- Migration 0025 — Enable Supabase Realtime for admin dashboard tables
-- Date: 2026-04-25
-- Author: Claude (platform Session D continued, UX polish + auto-refresh) with owner sign-off
-- Reason: The admin dashboard polls nothing today — Charlotte hits refresh
--         to see new leads land, outcome changes propagate, errors appear.
--         Owner asked for auto-refresh. Supabase Realtime broadcasts
--         Postgres changes via WebSocket to authenticated clients. Adding
--         the four high-traffic admin tables to the supabase_realtime
--         publication enables a small client wrapper to subscribe and call
--         router.refresh() when events fire.
--
--         Tables added:
--           - leads.submissions   (new leads, status updates)
--           - leads.routing_log   (routing events)
--           - crm.enrolments      (outcome changes via form or auto-flip)
--           - leads.dead_letter   (errors landing)
--
--         RLS still applies: subscribers only receive events for rows they
--         can SELECT. Admin users (per migration 0014's admin_read_*
--         policies) get every event; non-admin authenticated users get
--         none. No PII leak through the broadcast layer.
--
-- Related: platform/docs/admin-dashboard-scoping.md § Session D UX pass.

-- UP

ALTER PUBLICATION supabase_realtime ADD TABLE leads.submissions;
ALTER PUBLICATION supabase_realtime ADD TABLE leads.routing_log;
ALTER PUBLICATION supabase_realtime ADD TABLE crm.enrolments;
ALTER PUBLICATION supabase_realtime ADD TABLE leads.dead_letter;

-- DOWN
-- ALTER PUBLICATION supabase_realtime DROP TABLE leads.submissions;
-- ALTER PUBLICATION supabase_realtime DROP TABLE leads.routing_log;
-- ALTER PUBLICATION supabase_realtime DROP TABLE crm.enrolments;
-- ALTER PUBLICATION supabase_realtime DROP TABLE leads.dead_letter;
