-- Migration 0141 — track welcome-deck completion per provider user
-- Date:   2026-05-14
-- Author: Sasha (Charlotte's session)
-- Reason:
--   `/provider/welcome` becomes the gated first-login experience. Every
--   provider user (admin or regular) must click through the deck once
--   before they can reach any other /provider/* route. Skip button is
--   removed; final-slide CTA flips this column to now() via a Server
--   Action. SLA-acceptance gate stays separate and is hit by the first
--   admin AFTER the welcome flow completes.
--
--   Once set, the column doesn't get cleared — a user only sees the
--   forced flow once. Revisits go via /provider/support's "Get started"
--   link.
--
-- UP
ALTER TABLE crm.provider_users
  ADD COLUMN welcome_completed_at TIMESTAMPTZ;

-- DOWN
-- ALTER TABLE crm.provider_users DROP COLUMN welcome_completed_at;
