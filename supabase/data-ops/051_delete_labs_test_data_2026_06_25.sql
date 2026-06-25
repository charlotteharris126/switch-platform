-- Data-op 051 — delete all labs.events test data
-- Date: 2026-06-25
-- Author: Claude (Sasha session) with owner review
-- Reason: All 47 rows in labs.events are from pre-launch testing (Charlotte's own
--   sessions, explicit Sasha test sessions, and ad-hoc verification runs). No real
--   ad traffic has hit labs.switchable.org.uk yet. Clearing the table gives a clean
--   baseline before the first paid test is launched.
-- Impact: labs.events emptied. capi_log rows referencing these labs events are in
--   leads.capi_log (brand='labs') — those can stay (they're CAPI test sends, not
--   billable). The RESTART IDENTITY resets the sequence so IDs start from 1 again.
-- Verification: after running, SELECT count(*) FROM labs.events should return 0.
-- Owner runs this in the Supabase SQL editor (service role). Read-only MCP cannot write.

TRUNCATE TABLE labs.events RESTART IDENTITY;
