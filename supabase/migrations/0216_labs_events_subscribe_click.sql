-- Migration 0216 — add 'subscribe_click' to labs.events event check constraint
-- Date: 2026-06-24
-- Author: Claude (Sasha session)
-- Reason: labs-event EF already allows subscribe_click in ALLOWED_EVENTS (added
--   Labs S4), but the DB-level CHECK was never updated to match. subscribe_click
--   fires when a user clicks the upsell CTA on /gaply/upsell/ and is needed for
--   the Gaply Subscribe CAPI event. The mismatch caused a 500 on every
--   subscribe_click POST (constraint violation on INSERT).
-- Related: platform/supabase/migrations/0181_labs_events.sql (original constraint),
--   platform/supabase/functions/labs-event/index.ts.
-- Impact: additive constraint change only. No consumer queries for specific event
--   values in a way that breaks. Rollback: DOWN below.
-- Sign-off: Charlotte (this session).

-- UP
ALTER TABLE labs.events DROP CONSTRAINT events_event_check;
ALTER TABLE labs.events ADD CONSTRAINT events_event_check
  CHECK (event IN ('run', 'unlock_intent', 'signup', 'subscribe_click'));

-- DOWN
-- ALTER TABLE labs.events DROP CONSTRAINT events_event_check;
-- ALTER TABLE labs.events ADD CONSTRAINT events_event_check
--   CHECK (event IN ('run', 'unlock_intent', 'signup'));
