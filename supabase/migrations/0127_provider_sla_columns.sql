-- Migration 0127 — per-provider SLA columns on crm.providers
-- Date: 2026-05-12
-- Author: Claude (Sasha)
-- Reason:
--   The portal's "Overdue" badge + nav stale-attempt counter + home
--   action cards all run off a hardcoded 36-hour stale-attempt
--   threshold. That fits learner providers (EMS / CD / WYK — call
--   cadence is days). It doesn't fit Riverside (B2B — 3 attempts over
--   a fortnight, so ~5 days between calls). Hardcoded 36h over-nags
--   Riverside's workflow.
--
--   Solution: move SLA values onto the provider row so each pilot
--   provider carries its own thresholds. New providers inherit the
--   defaults below (PPA v1 funded-pilot shape); PPA v2 providers
--   (Riverside, dual-route apprenticeships) get the longer values
--   seeded.
--
--   Five SLA dimensions baked in:
--     - sla_first_attempt_hours    — how soon after lead arrival the
--                                     provider must make first contact
--                                     (1 working day = 24h, both PPAs)
--     - sla_attempts_required      — how many attempts before
--                                     cannot_reach is the right move
--                                     (3 attempts, both PPAs)
--     - sla_attempt_window_days    — the timeframe those attempts must
--                                     happen across (7 days for learner,
--                                     14 days for employer)
--     - sla_stale_attempt_hours    — when a single attempt status is
--                                     "stale, needs retry" (36h
--                                     learner, 120h employer)
--     - sla_presumed_flip_days     — when the auto-flip cron should
--                                     bump a non-terminal lead to
--                                     presumed enrolled/signed
--                                     (14 days learner, 60 days
--                                     employer)
--
--   These get consumed by:
--     - portal stale-attempt logic (overdue badge, nav counter, home card)
--     - the auto-flip cron once that ships (migration 0097 still pending)
--     - future "Re-agree the SLA on first sign-in" UX
--
-- Impact assessment:
--   1. Change: 5 new NOT NULL columns on crm.providers with sensible
--      defaults. Riverside gets a 1-row UPDATE post-CREATE.
--   2. Readers: portal (provider shell + leads list + lead detail +
--      home), admin preview, auto-flip cron (when shipped).
--   3. Writers: data-ops + manual admin UI later. Defaults fire on insert
--      so new pilot rows are safe.
--   4. Rollback: drop the 5 columns.
--   5. Sign-off: owner pending.

BEGIN;

ALTER TABLE crm.providers
  ADD COLUMN IF NOT EXISTS sla_first_attempt_hours   INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS sla_attempts_required     INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS sla_attempt_window_days   INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS sla_stale_attempt_hours   INTEGER NOT NULL DEFAULT 36,
  ADD COLUMN IF NOT EXISTS sla_presumed_flip_days    INTEGER NOT NULL DEFAULT 14;

COMMENT ON COLUMN crm.providers.sla_first_attempt_hours IS
  'How quickly the provider must make first contact after a lead is routed. Hours. Defaults to 24 (1 working day).';
COMMENT ON COLUMN crm.providers.sla_attempts_required IS
  'How many attempts the provider must make before marking cannot_reach is acceptable. Defaults to 3.';
COMMENT ON COLUMN crm.providers.sla_attempt_window_days IS
  'Days across which the attempts must happen. Defaults to 7 for learner (PPA v1), set to 14 for employer (PPA v2).';
COMMENT ON COLUMN crm.providers.sla_stale_attempt_hours IS
  'When a single attempt status (1st/2nd/3rd no answer) is "stale, needs retry". Drives Overdue badge in portal. Default 36 (PPA v1, daily cadence); Riverside set to 120 (PPA v2, weekly cadence).';
COMMENT ON COLUMN crm.providers.sla_presumed_flip_days IS
  'Days after which auto-flip cron bumps a non-terminal lead to presumed enrolled (learner) or presumed signed (employer). Default 14 (PPA v1); set to 60 for PPA v2.';

-- Seed PPA v2 providers (Riverside) with the longer thresholds.
-- Funnels through agreement_version so future v2 onboardings inherit
-- automatically when they're seeded with agreement_version='v2'.
UPDATE crm.providers
SET
  sla_attempt_window_days = 14,
  sla_stale_attempt_hours = 120,
  sla_presumed_flip_days  = 60
WHERE agreement_version = 'v2';

COMMIT;

-- DOWN
-- BEGIN;
-- ALTER TABLE crm.providers
--   DROP COLUMN IF EXISTS sla_first_attempt_hours,
--   DROP COLUMN IF EXISTS sla_attempts_required,
--   DROP COLUMN IF EXISTS sla_attempt_window_days,
--   DROP COLUMN IF EXISTS sla_stale_attempt_hours,
--   DROP COLUMN IF EXISTS sla_presumed_flip_days;
-- COMMIT;
