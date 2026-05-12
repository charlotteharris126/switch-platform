-- Data fix 025 — backfill historic NULL/empty intake IDs + close past-cohort leads
-- Date:   2026-05-11
-- Owner:  Charlotte (decided 2026-05-11 — EMS 6 May cohort filter surfaced the gap)
-- Reason:
--   The fastrack form started capturing preferred_intake_id +
--   acceptable_intake_ids on 2026-04-29 (multi-date introduction). Two
--   populations of leads still carry NULL or empty intake fields:
--
--     1. Pre-2026-04-29 leads — form didn't capture intake yet. The course
--        YAMLs at the time had a single open intake per course:
--           counselling-skills-tees-valley  → tees-valley-2026-05-06
--           smm-for-ecommerce-tees-valley   → tees-valley-2026-05-21
--           lift-digital-marketing-futures-lift-boroughs → lift-boroughs-2026-04-27
--        All these leads route to that intake.
--
--     2. Post-2026-05-05 counselling leads — 6 May removed from the
--        counselling YAML 2026-05-05; the funded course page form fails to
--        stamp the single remaining intake (tees-valley-2026-06-02) when
--        the picker is collapsed to one option (form bug — Mable's queue).
--        These 17 leads carry preferred=NULL, acceptable='{}'.
--
--     Deliberately NOT touched:
--       - 2 EMS SMM cannot_reach leads routed in the multi-window
--         (2026-04-29 → 2026-05-05) with NULL intake. Both 21 May and
--         26 May were open in that window; can't determine which the
--         learner intended. Per Charlotte's rule "don't guess cohort
--         dates, only stamp when sure": leave them NULL. Andy can assign
--         in the portal if/when he picks them up.
--
--   In parallel, the operational rule "after course start date passed,
--   lead should be closed" fires on:
--     - tees-valley-2026-05-06 (counselling) — started 5 days ago
--     - lift-boroughs-2026-04-27 (lift digital) — started 2 weeks ago
--   Any backfilled lead pointing at either of these cohorts AND currently
--   in open / attempt_X / enrolment_meeting_booked transitions to lost
--   with lost_reason='cohort_decline'.
--
--   Deliberately NOT touched by the closure rule:
--     - enrolled / presumed_enrolled — they're the success states
--     - lost — already a terminal closure state
--     - cannot_reach — provider has already given up calling; transitioning
--       to lost would erase that history. cannot_reach IS effectively
--       closure of its own kind; the cohort-started rule overlapping with
--       it doesn't add useful signal.
--
--   tees-valley-2026-05-21 (SMM) hasn't started yet (today 2026-05-11) so
--   nothing fires there.
--
--   Closed cohort 2026-05-06 also gets added to crm.course_intakes so the
--   portal cohort filter has a label for it (status='closed').
--
--   Long-term fix lives in Mable's queue: the funded course page must
--   stamp preferred_intake_id from the YAML at build time, regardless of
--   whether the picker is shown to the learner. Until that ships, this
--   data-ops will need re-running periodically.
--
-- Pre-flight counts (verified 2026-05-11):
--   EMS counselling NULL/empty:  62 (45 pre-multi + 17 post-removal)  → backfilled
--   EMS SMM NULL pre-multi:      25                                    → backfilled
--   EMS SMM NULL multi-window:    2                                    → INTENTIONALLY LEFT NULL
--   WYK lift NULL:               14 (all pre-multi)                    → backfilled
--   Total intake stamps:        101
--   Closure transitions:          9 (EMS counselling 'open' → 'lost')
--
-- Run plan:
--   Step 1: dry-run COUNT(*) queries — match pre-flight numbers above.
--   Step 2: open a transaction, run blocks 1-7, commit.
--   Step 3: post-flight COUNT(*) checks — zero NULL/empty for the target
--           course_id + provider_id pairs.
--   Step 4: log in platform/docs/changelog.md.

BEGIN;

-- ----------------------------------------------------------------------------
-- BLOCK 1 — counselling pre-multi (EMS): 45 leads → tees-valley-2026-05-06
-- ----------------------------------------------------------------------------
UPDATE leads.submissions
SET
  preferred_intake_id   = 'tees-valley-2026-05-06',
  acceptable_intake_ids = ARRAY['tees-valley-2026-05-06']::text[],
  updated_at            = now()
WHERE archived_at IS NULL
  AND parent_submission_id IS NULL
  AND primary_routed_to = 'enterprise-made-simple'
  AND course_id = 'counselling-skills-tees-valley'
  AND routed_at < TIMESTAMPTZ '2026-04-29 00:00:00+00'
  AND (preferred_intake_id IS NULL
       OR acceptable_intake_ids IS NULL
       OR acceptable_intake_ids = '{}'::text[]);

-- ----------------------------------------------------------------------------
-- BLOCK 2 — counselling post-removal (EMS): 17 leads → tees-valley-2026-06-02
-- ----------------------------------------------------------------------------
UPDATE leads.submissions
SET
  preferred_intake_id   = 'tees-valley-2026-06-02',
  acceptable_intake_ids = ARRAY['tees-valley-2026-06-02']::text[],
  updated_at            = now()
WHERE archived_at IS NULL
  AND parent_submission_id IS NULL
  AND primary_routed_to = 'enterprise-made-simple'
  AND course_id = 'counselling-skills-tees-valley'
  AND routed_at >= TIMESTAMPTZ '2026-05-05 00:00:00+00'
  AND (preferred_intake_id IS NULL
       OR acceptable_intake_ids IS NULL
       OR acceptable_intake_ids = '{}'::text[]);

-- ----------------------------------------------------------------------------
-- BLOCK 3 — SMM pre-multi (EMS): 25 leads → tees-valley-2026-05-21
-- ----------------------------------------------------------------------------
UPDATE leads.submissions
SET
  preferred_intake_id   = 'tees-valley-2026-05-21',
  acceptable_intake_ids = ARRAY['tees-valley-2026-05-21']::text[],
  updated_at            = now()
WHERE archived_at IS NULL
  AND parent_submission_id IS NULL
  AND primary_routed_to = 'enterprise-made-simple'
  AND course_id = 'smm-for-ecommerce-tees-valley'
  AND routed_at < TIMESTAMPTZ '2026-04-29 00:00:00+00'
  AND (preferred_intake_id IS NULL
       OR acceptable_intake_ids IS NULL
       OR acceptable_intake_ids = '{}'::text[]);

-- ----------------------------------------------------------------------------
-- BLOCK 4 — REMOVED.
--   2 SMM cannot_reach leads in the multi-window window are intentionally
--   left NULL. Per Charlotte's rule: don't guess cohort dates when two or
--   more cohorts were running at the time of submission.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- BLOCK 5 — lift-digital (WYK): 14 leads → lift-boroughs-2026-04-27
-- ----------------------------------------------------------------------------
UPDATE leads.submissions
SET
  preferred_intake_id   = 'lift-boroughs-2026-04-27',
  acceptable_intake_ids = ARRAY['lift-boroughs-2026-04-27']::text[],
  updated_at            = now()
WHERE archived_at IS NULL
  AND parent_submission_id IS NULL
  AND primary_routed_to = 'wyk-digital'
  AND course_id = 'lift-digital-marketing-futures-lift-boroughs'
  AND (preferred_intake_id IS NULL
       OR acceptable_intake_ids IS NULL
       OR acceptable_intake_ids = '{}'::text[]);

-- ----------------------------------------------------------------------------
-- BLOCK 6 — register 6 May counselling intake as historic-closed
-- ----------------------------------------------------------------------------
INSERT INTO crm.course_intakes (course_slug, intake_id, intake_date, status)
VALUES
  ('counselling-skills-tees-valley', 'tees-valley-2026-05-06', DATE '2026-05-06', 'closed')
ON CONFLICT (intake_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- BLOCK 7 — closure rule for past-start cohorts
--   Today is 2026-05-11. Cohorts that have already started:
--     - tees-valley-2026-05-06 (counselling, started 5 days ago)
--     - lift-boroughs-2026-04-27 (lift, started 2 weeks ago)
--   For any backfilled lead pointing at these in a non-enrolled state,
--   transition to lost with lost_reason='cohort_decline'. Skip
--   enrolled / presumed_enrolled / already-lost rows.
--
--   Enrolments row may not exist for never-actioned leads. Create one with
--   the closure if missing; otherwise UPDATE in place.
-- ----------------------------------------------------------------------------

-- 7a — INSERT enrolments rows for backfilled-past-cohort leads that have no
--      enrolment record yet. Status starts at 'open' so 7b can transition.
INSERT INTO crm.enrolments (submission_id, provider_id, status, status_updated_at)
SELECT s.id, s.primary_routed_to, 'open', now()
FROM leads.submissions s
LEFT JOIN crm.enrolments e ON e.submission_id = s.id
WHERE s.archived_at IS NULL
  AND s.parent_submission_id IS NULL
  AND e.submission_id IS NULL
  AND s.preferred_intake_id IN (
    'tees-valley-2026-05-06',
    'lift-boroughs-2026-04-27'
  )
  AND s.primary_routed_to IN ('enterprise-made-simple', 'wyk-digital');

-- 7b — Transition leads in "still working it" states on past-start cohorts
--      to lost. Explicitly only fires on open / attempt_X /
--      enrolment_meeting_booked. Excluded:
--        - enrolled / presumed_enrolled (success states — leave alone)
--        - lost (already terminal — leave alone)
--        - cannot_reach (provider already gave up; transitioning would
--          erase that history — leave alone per Charlotte's data-drift
--          caution)
UPDATE crm.enrolments e
SET
  status               = 'lost',
  lost_reason          = 'cohort_decline',
  status_updated_at    = now(),
  outcome_note         = COALESCE(NULLIF(e.outcome_note, ''), '') ||
                         CASE WHEN COALESCE(e.outcome_note, '') = '' THEN '' ELSE E'\n' END ||
                         '[2026-05-11 backfill: cohort start date passed without enrolment]'
FROM leads.submissions s
WHERE e.submission_id = s.id
  AND s.archived_at IS NULL
  AND s.parent_submission_id IS NULL
  AND s.preferred_intake_id IN (
    'tees-valley-2026-05-06',
    'lift-boroughs-2026-04-27'
  )
  AND e.status IN (
    'open',
    'attempt_1_no_answer',
    'attempt_2_no_answer',
    'attempt_3_no_answer',
    'enrolment_meeting_booked'
  );

COMMIT;

-- ----------------------------------------------------------------------------
-- Post-flight verification queries (run separately, not in the transaction)
-- ----------------------------------------------------------------------------
-- Expect zero rows:
-- SELECT primary_routed_to, course_id, COUNT(*)
-- FROM leads.submissions
-- WHERE archived_at IS NULL
--   AND parent_submission_id IS NULL
--   AND routed_at IS NOT NULL
--   AND primary_routed_to IN ('enterprise-made-simple','wyk-digital')
--   AND course_id IN (
--     'counselling-skills-tees-valley',
--     'smm-for-ecommerce-tees-valley',
--     'lift-digital-marketing-futures-lift-boroughs'
--   )
--   AND (preferred_intake_id IS NULL
--        OR acceptable_intake_ids IS NULL
--        OR acceptable_intake_ids = '{}'::text[])
-- GROUP BY 1, 2;
--
-- Expect tees-valley-2026-05-06 row in crm.course_intakes with status='closed':
-- SELECT * FROM crm.course_intakes WHERE intake_id = 'tees-valley-2026-05-06';
--
-- Expect exactly 9 rows transitioned to lost+cohort_decline via this backfill
-- (all EMS counselling, previously status='open' pointing at tees-valley-2026-05-06):
-- SELECT e.status, e.lost_reason, COUNT(*)
-- FROM crm.enrolments e
-- JOIN leads.submissions s ON s.id = e.submission_id
-- WHERE s.preferred_intake_id IN ('tees-valley-2026-05-06','lift-boroughs-2026-04-27')
-- GROUP BY 1, 2;
--
-- Sanity audit: confirm zero enrolled/presumed_enrolled rows were touched:
-- SELECT COUNT(*) FROM crm.enrolments e
-- JOIN leads.submissions s ON s.id = e.submission_id
-- WHERE s.preferred_intake_id IN ('tees-valley-2026-05-06','lift-boroughs-2026-04-27')
--   AND e.status_updated_at > TIMESTAMPTZ '2026-05-11 12:00:00+00'
--   AND e.status IN ('enrolled','presumed_enrolled');
-- Must return 0.
