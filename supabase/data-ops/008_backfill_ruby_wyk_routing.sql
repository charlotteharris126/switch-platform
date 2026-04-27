-- data-ops 008 - Manual back-fill: route Ruby Marle (submission 49) and
--                 Laura Hawdon (submission 51) to WYK Digital
-- Date: 2026-04-21 (Session 5, post-deploy)
-- Author: Claude (Session 5) with owner review
-- Reason:
--   Ruby Marle submitted the first WYK/LIFT lead at 2026-04-21 20:03 UTC
--   (id 49, Camden, NW5 4SF). Laura Hawdon followed at 20:39 UTC (id 51,
--   Islington, N4 3AD). Both submitted during the Session 5 deploy window -
--   Ruby before wyk-digital was seeded in crm.providers, Laura during or
--   very near the Edge Function deploy. In both cases netlify-lead-router
--   either had no valid candidate provider (Ruby) or didn't extract the new
--   canonical columns (Laura: postcode NULL despite raw_payload having
--   N4 3AD). Neither lead was routed.
--
--   After Session 5 deploy:
--     1. migration 0011 + 0012 applied
--     2. data-ops/007 Part 1 applied (wyk-digital INSERT)
--     3. data-ops/007 Part 3 applied (WYK sheet + webhook URL)
--
--   This file finishes what the confirm-click would have done: write the
--   routing_log row, set primary_routed_to, log the back-fill rationale.
--   Same pattern as data-ops/005 (Melanie Watson manual back-fill from the
--   2026-04-21 Session 3.3 incident).
--
--   The sheet append + provider email are done manually by the owner:
--   owner pastes Ruby's row into WYK's new sheet, then sends a PII-free
--   "first lead in your sheet" email to Heena. NOT triggered by this SQL.
--   This avoids re-signing the confirm-link token (which would require the
--   ROUTING_CONFIRM_SHARED_SECRET) and keeps the back-fill auditable in SQL.
--
-- Related:
--   - platform/supabase/data-ops/005_melanie_routing_and_curl_cleanup.sql (precedent)
--   - platform/supabase/data-ops/007_session_5_provider_seeds.sql (seeds wyk-digital)
--   - platform/docs/changelog.md 2026-04-21 (evening) Session 5 entry
--
-- Pre-flight checks:
--   - crm.providers row for 'wyk-digital' exists and is active (from data-ops/007 Part 1)
--   - leads.submissions id = 49, primary_routed_to IS NULL, provider_ids = {wyk-digital}
--   - Owner has created WYK sheet + deployed Apps Script v2 + applied Part 3
--
-- Idempotency: guarded by WHERE primary_routed_to IS NULL on the UPDATE;
-- routing_log INSERT is not guarded (run this exactly once).
--
-- Run as owner (service role) via Supabase SQL editor.

BEGIN;

-- Pre-flight verification. Expect both rows active + un-routed, WYK provider active.
SELECT
  s.id,
  s.first_name,
  s.last_name,
  s.primary_routed_to,
  s.provider_ids,
  s.funding_route,
  p.provider_id  AS provider_row,
  p.active       AS provider_active
FROM leads.submissions s
LEFT JOIN crm.providers p ON p.provider_id = 'wyk-digital'
WHERE s.id IN (49, 51)
ORDER BY s.id;

-- If provider_row=NULL or provider_active=false, STOP and apply data-ops/007
-- Part 1 first. ROLLBACK and try again.

-- Mark Ruby (49) and Laura (51) routed to WYK Digital.
-- Idempotent via primary_routed_to IS NULL guard.
-- Also populate postcode from raw_payload for Laura (id 51) who submitted
-- during the Session 5 deploy window and missed canonical extraction.
WITH ruby_laura_postcode_backfill AS (
  UPDATE leads.submissions
     SET postcode = UPPER(REGEXP_REPLACE(raw_payload->'data'->>'postcode', '\s+', '', 'g')),
         updated_at = now()
   WHERE id IN (49, 51)
     AND postcode IS NULL
     AND raw_payload->'data'->>'postcode' IS NOT NULL
  RETURNING id
),
updated AS (
  UPDATE leads.submissions
     SET primary_routed_to = 'wyk-digital',
         routed_at         = now(),
         updated_at        = now()
   WHERE id IN (49, 51)
     AND primary_routed_to IS NULL
  RETURNING id
)
INSERT INTO leads.routing_log (
  submission_id, provider_id, route_reason, delivery_method, delivery_status, error_message
)
SELECT
  id,
  'wyk-digital',
  'primary',
  'manual_backfill',  -- delivery_method has no CHECK constraint (per data-ops/005 precedent)
  'sent',
  'Routed manually after Session 5 deploy. Ruby (49) missed owner-notification because wyk-digital was not in crm.providers at submit time (20:03 UTC); Laura (51) submitted during the Edge Function deploy window (20:39 UTC) and missed canonical column extraction. Both pasted manually into WYK sheet; this row records the logical routing so reports and Sasha reconcile correctly.'
FROM updated;

-- Verify
SELECT
  s.id,
  s.first_name,
  s.primary_routed_to,
  s.routed_at,
  s.postcode,
  r.provider_id AS routed_to,
  r.delivery_method,
  r.route_reason
FROM leads.submissions s
JOIN leads.routing_log r ON r.submission_id = s.id AND r.provider_id = 'wyk-digital'
WHERE s.id IN (49, 51)
ORDER BY s.id;

-- If verification shows both rows with primary_routed_to='wyk-digital',
-- delivery_method='manual_backfill', postcode populated, COMMIT. Otherwise ROLLBACK.

COMMIT;

-- After COMMIT:
--   1. Owner opens WYK's new Google Sheet and pastes Ruby's row manually.
--      Row values (in EMS-compatible header order, adjust columns to match whatever
--      headers the WYK sheet actually uses - Apps Script v2 on the sheet is
--      header-driven, but the sheet has no ingress for this back-fill row):
--
--         Lead ID: SL-26-04-0049
--         Submitted at: 21/04/2026 20:03
--         Course: Lift Digital Marketing Futures Lift Boroughs
--         Name: Ruby isla Cera Marle
--         Email: rubyislaceramarle@gmail.com
--         Phone: 07582364202
--         LA: camden
--         Postcode: NW5 4SF
--         Age band: 18_plus
--         Employment: unemployed
--         Prior L3: (blank - not captured)
--         Start date checked: yes
--         Provider: wyk-digital
--         Status: open
--
--   2. Owner sends a PII-free email to Heena Uppal (heena@wykgroup.co.uk):
--      see the drafted text in platform/docs/handoff-emails/heena-first-lead.md
--      (draft to follow alongside this data-ops in the session).
