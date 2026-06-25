-- Migration 0217 — add plans_skip to labs.events event CHECK constraint
-- Date: 2026-06-25
-- Author: Claude (Sasha session)
-- Reason: plans page fires plans_skip when user clicks "I'll figure it out on my own".
--   Smoke-test signal: saw the plans, chose to leave. Worth storing alongside subscribe_click.
--   labs-event EF ALLOWED_EVENTS updated in the same deploy.

-- UP
ALTER TABLE labs.events
  DROP CONSTRAINT events_event_check,
  ADD CONSTRAINT events_event_check
    CHECK (event = ANY (ARRAY['run','unlock_intent','signup','subscribe_click','plans_skip']));

-- DOWN
-- ALTER TABLE labs.events
--   DROP CONSTRAINT events_event_check,
--   ADD CONSTRAINT events_event_check
--     CHECK (event = ANY (ARRAY['run','unlock_intent','signup','subscribe_click']));
