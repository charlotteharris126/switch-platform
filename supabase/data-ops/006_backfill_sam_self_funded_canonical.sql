-- data-ops 006 - backfill submission 34 (Sam Stevens) into self-funded canonical columns
-- Date: 2026-04-21 (Session 5)
-- Author: Claude (Session 5) with owner review
-- Reason: Submission 34 is the first self-funded lead (Sam Stevens, Courses
--         Direct, 2026-04-21 morning). Landed before migration 0011 added
--         canonical columns, so postcode / reason / interest / situation /
--         qualification / start_when / budget / courses_selected live only
--         in raw_payload. This script pulls them into the new columns so
--         reports, Metabase, and future Apps Script v2 re-sends don't have
--         to JSON-parse raw_payload for id 34.
--
-- Related:
--   - platform/supabase/migrations/0011_add_self_funded_canonical_cols.sql
--   - platform/docs/changelog.md 2026-04-21 morning entry (Sam's manual handling)
--
-- Pattern: two-step - first a SELECT so the owner can eyeball what will
-- change, then the UPDATE. Both wrapped in a transaction. Re-runnable:
-- re-running overwrites with the same values derived from raw_payload.
--
-- Idempotency guard: only touches id = 34. No side effects on other rows.
--
-- Before running:
--   1. Apply migration 0011 first. Verify with:
--        \d leads.submissions
--      Columns postcode, region, reason, interest, situation, qualification,
--      start_when, budget, courses_selected must exist.
--   2. Inspect the SELECT output. The raw_payload field names we read
--      (`data->>'postcode'`, etc.) reflect the switchable-self-funded form's
--      hidden-input keys as of 2026-04-21. If any come back NULL where a
--      value is expected, the form may have used a different key - adjust
--      the extract expression before running the UPDATE.
--   3. Region stays NULL until Session 5.1 loads reference.postcodes.
--      Sam's postcode is PE16 6LS → East of England (ONS). Owner can
--      manually UPDATE that single value if desired before reconcile.
--
-- Run as owner (service role) via Supabase SQL editor.

-- Step 1 - inspect
-- The switchable-self-funded form uses `start-when` (hyphen) and
-- `courses-selected` (hyphen) for two hidden inputs while the rest
-- of the preference fields use underscores. Both shapes are probed.
-- `courses_selected` is pipe-joined (` | `) by the form, so backfill
-- splits on `,` AND `|`.
SELECT
  id,
  email,
  raw_payload->'data'->>'postcode'         AS raw_postcode,
  raw_payload->'data'->>'reason'           AS raw_reason,
  raw_payload->'data'->>'interest'         AS raw_interest,
  raw_payload->'data'->>'situation'        AS raw_situation,
  raw_payload->'data'->>'qualification'    AS raw_qualification,
  COALESCE(
    raw_payload->'data'->>'start_when',
    raw_payload->'data'->>'start-when'
  ) AS raw_start_when,
  raw_payload->'data'->>'budget'           AS raw_budget,
  COALESCE(
    raw_payload->'data'->>'courses_selected',
    raw_payload->'data'->>'courses-selected'
  ) AS raw_courses_selected
FROM leads.submissions
WHERE id = 34;

-- Step 2 - apply (uncomment after reviewing step 1)
-- BEGIN;
--
-- WITH raw AS (
--   SELECT
--     UPPER(REGEXP_REPLACE(COALESCE(raw_payload->'data'->>'postcode', ''), '\s+', '', 'g')) AS postcode,
--     raw_payload->'data'->>'reason'        AS reason,
--     raw_payload->'data'->>'interest'      AS interest,
--     raw_payload->'data'->>'situation'     AS situation,
--     raw_payload->'data'->>'qualification' AS qualification,
--     COALESCE(raw_payload->'data'->>'start_when', raw_payload->'data'->>'start-when') AS start_when,
--     raw_payload->'data'->>'budget'        AS budget,
--     COALESCE(raw_payload->'data'->>'courses_selected', raw_payload->'data'->>'courses-selected') AS courses_selected_raw
--   FROM leads.submissions WHERE id = 34
-- )
-- UPDATE leads.submissions s
--    SET postcode         = NULLIF(r.postcode, ''),
--        reason           = r.reason,
--        interest         = r.interest,
--        situation        = r.situation,
--        qualification    = r.qualification,
--        start_when       = r.start_when,
--        budget           = r.budget,
--        courses_selected = CASE
--                             WHEN r.courses_selected_raw IS NULL THEN NULL
--                             ELSE ARRAY(
--                               SELECT TRIM(tok)
--                                 FROM regexp_split_to_table(r.courses_selected_raw, '[,|]') AS tok
--                                WHERE TRIM(tok) <> ''
--                             )
--                           END,
--        updated_at       = now()
--   FROM raw r
--  WHERE s.id = 34;
--
-- -- Verify
-- SELECT id, postcode, region, reason, interest, situation, qualification, start_when, budget,
--        courses_selected, primary_routed_to
--   FROM leads.submissions
--  WHERE id = 34;
--
-- COMMIT;

-- Optional one-liner for Sam's region (ONS lookup for PE16 6LS → East of England).
-- Run only if you want region populated before Session 5.1 loads reference.postcodes.
--   UPDATE leads.submissions SET region = 'East of England' WHERE id = 34;
