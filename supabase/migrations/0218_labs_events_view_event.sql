-- Migration 0218 — add 'view' event type to labs.events
-- Date: 2026-06-25
-- Author: Claude (Sasha session) with owner review
-- Reason: The /admin/labs funnel needs a top-of-funnel "views" count (page loads before
--   the user runs the tool). Without it the funnel starts at "runs", missing the
--   landing-page drop-off that paid ads will expose. The browser fires a 'view' event
--   on page load; CAPI is not sent for views (no purchase intent).
-- Related: 0216 (subscribe_click), 0217 (plans_skip), labs-event/index.ts,
--   labs/public/gaply/app.js, 0219 (updated funnel RPC).

-- UP
ALTER TABLE labs.events
  DROP CONSTRAINT events_event_check,
  ADD CONSTRAINT events_event_check
    CHECK (event = ANY (ARRAY['view','run','unlock_intent','signup','subscribe_click','plans_skip']));

-- DOWN
-- ALTER TABLE labs.events
--   DROP CONSTRAINT events_event_check,
--   ADD CONSTRAINT events_event_check
--     CHECK (event = ANY (ARRAY['run','unlock_intent','signup','subscribe_click','plans_skip']));
