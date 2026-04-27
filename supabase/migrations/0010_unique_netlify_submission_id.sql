-- Migration 0010 — unique partial index on Netlify submission ID
-- Date: 2026-04-21
-- Author: Claude (Session 3.3) with owner review
-- Reason: The new netlify-leads-reconcile Edge Function back-fills any leads that
--   never reached leads.submissions by cross-checking Netlify's submission store
--   against our DB. To keep that process idempotent — a reconcile run overlapping
--   with a recovered webhook delivery must not produce duplicate rows — we need
--   a unique identifier on the Netlify submission side. Netlify's outgoing-webhook
--   payload includes its own stable submission id at the top level, which we
--   already persist in raw_payload.id. This migration promotes that to a unique
--   constraint.
--
--   Partial: two historical rows (one curl_direct_test, one Lucy Hizmo manual
--   back-fill via data-ops/003) predate the webhook path and have no Netlify id.
--   Partial WHERE raw_payload->>'id' IS NOT NULL permits those legacy rows while
--   still enforcing uniqueness for every webhook-captured submission.
--
-- Related:
--   - platform/docs/data-architecture.md — leads.submissions section (update with this index after apply)
--   - platform/docs/changelog.md — 2026-04-21 Session 3.3 entry
--   - .claude/rules/data-infrastructure.md §3 — migration file rules
--
-- Before running:
--   1. Verify no existing duplicates:
--        SELECT raw_payload->>'id', count(*)
--          FROM leads.submissions
--         WHERE raw_payload->>'id' IS NOT NULL
--         GROUP BY raw_payload->>'id'
--        HAVING count(*) > 1;
--      Expect zero rows. (Checked on 2026-04-21 before writing this migration.)
--   2. Run this file as one transaction in the Supabase SQL editor.
--   3. Verify with the query at the bottom of this file.

-- UP

CREATE UNIQUE INDEX leads_submissions_netlify_id_uniq
    ON leads.submissions ((raw_payload->>'id'))
 WHERE raw_payload->>'id' IS NOT NULL;

COMMENT ON INDEX leads.leads_submissions_netlify_id_uniq IS
  'Unique partial index on Netlify outgoing-webhook submission id (raw_payload.id). Enforces idempotency for netlify-leads-reconcile back-fills. Partial because pre-webhook rows (curl tests, manual back-fills) have no Netlify id.';

-- Sanity check:
-- SELECT indexname FROM pg_indexes WHERE schemaname='leads' AND indexname='leads_submissions_netlify_id_uniq';

-- DOWN
-- DROP INDEX leads.leads_submissions_netlify_id_uniq;
