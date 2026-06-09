-- Migration 0205 — archive webhook-diagnostic test leads (584, 585)
-- Date: 2026-06-09
-- Author: Claude (Sasha/platform) with owner sign-off
-- Reason: 584 + 585 are the WEBHOOKTEST submissions pushed via curl during the
--   2026-06-09 webhook-lag diagnosis (deliberately DQ'd, earnings over_30k, so
--   neither routed to a provider). Archive them out of reporting so they don't
--   skew lead numbers. Data fix (not schema); transactional.
-- Impact: 2 submissions archived. Neither was routed (DQ), so no provider portal
--   entry or enrolment to remove. No provider was notified about them.

-- UP
UPDATE leads.submissions SET archived_at = now()
 WHERE id IN (584, 585) AND archived_at IS NULL;

-- DOWN
-- UPDATE leads.submissions SET archived_at = NULL WHERE id IN (584, 585);
