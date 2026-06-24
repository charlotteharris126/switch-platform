-- Migration 0215 — expand leads.capi_log brand check to include 'labs'
-- Date: 2026-06-23
-- Author: Claude (Sasha session)
-- Reason: Gaply CAPI wiring fires Lead and Subscribe events from the labs-event
--   Edge Function. These don't belong to b2c (learner funnel) or b2b (employer
--   funnel), so the brand needs its own value. Additive constraint change only.
-- Related: platform/supabase/functions/labs-event/index.ts,
--   platform/supabase/functions/_shared/meta-capi.ts,
--   platform/docs/changelog.md.
-- Impact:
--   - capi-reconcile-daily: iterates dynamically over brands in the log; 'labs'
--     rows will surface in the reconcile email automatically (expected=0, sent=N).
--     No code change needed there.
--   - netlify-lead-router / netlify-employer-lead-router: unaffected (still pass
--     'b2c' / 'b2b', both remain valid).
--   - Rollback: DOWN below.
-- Sign-off: Charlotte (this session).

-- UP
ALTER TABLE leads.capi_log DROP CONSTRAINT capi_log_brand_check;
ALTER TABLE leads.capi_log ADD CONSTRAINT capi_log_brand_check
  CHECK (brand IN ('b2c', 'b2b', 'labs'));

-- DOWN
-- ALTER TABLE leads.capi_log DROP CONSTRAINT capi_log_brand_check;
-- ALTER TABLE leads.capi_log ADD CONSTRAINT capi_log_brand_check
--   CHECK (brand IN ('b2c', 'b2b'));
