-- Migration 0080 — pause the enrolment auto-flip cron
-- Date:    2026-05-06
-- Author:  Claude (platform session 33) on Charlotte's instruction
-- Reason:  The 14-day auto-flip from 'open' to 'presumed_enrolled' fired at
--          06:00 UTC today and flipped 4 leads (Sam @ Courses Direct; Ruby,
--          Laura, Raveena @ WYK Digital). Providers had not been warned the
--          14-day silence triggers a billing event, so the flip was
--          operationally premature even though contractually correct (clause
--          6.5). Charlotte chose to pause the cron until we ship a more
--          robust strategy — most likely a day-12 warning email to the
--          provider so they can confirm/dispute before any auto-flip runs.
--
--          Function `crm.run_enrolment_auto_flip()` is left in place. We're
--          just unscheduling the daily trigger, not deleting the logic. Re-
--          enabling is a single SQL line (see DOWN section).
--
-- Related: migration 0023 (created the cron), 0028/0045/0054/0067 (function
--          body refinements), data-ops/014_revert_auto_flip_2026_05_06.sql
--          (today's revert of the 4 affected rows).

-- UP
SELECT cron.unschedule('enrolment-auto-flip-daily');

-- DOWN
-- Re-enable the cron exactly as migration 0023 originally scheduled it:
-- SELECT cron.schedule('enrolment-auto-flip-daily', '0 6 * * *', $$SELECT crm.run_enrolment_auto_flip();$$);
