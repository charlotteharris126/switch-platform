-- Data-op 021 — seed fastrack_submissions rows for two demo provider leads
-- Date:    2026-05-10
-- Author:  Claude (platform Session 39) on Charlotte's instruction
-- Purpose: The "Fastrack" badge + "pin to top" sort on the leads list
--          and the badge on the lead detail page have no rows to render
--          for the demo provider — none of its 12 seeded leads carry a
--          fastrack submission. This seeds two so Charlotte can see the
--          UI behaviour against demo data.
--
--          Two rows so the pinning effect is visible (one would just
--          look like the natural top-of-list sort). Different shapes:
--          one with cohort_confirmed=true (clean fastrack), one with
--          l3_mismatch_flag=true (the trickier path that drives the
--          fastrack-l3-mismatch waitlist redirect).
--
--          Demo lead ids targeted:
--            347 Aisha Patel — cohort_confirmed fastrack
--            350 James Wilson — l3_mismatch fastrack (drives different UI later)
--
-- Side-effects: 2 rows in leads.fastrack_submissions, marked as demo
-- via the parent submission's primary_routed_to (already is_demo=true).

INSERT INTO leads.fastrack_submissions (
  schema_version, parent_submission_id, submitted_at,
  cohort_confirmed, transport_help_requested, docs_ready,
  l3_reconfirmed, l3_mismatch_flag,
  voice_of_learner_intro, terms_accepted, marketing_opt_in,
  raw_payload
)
VALUES
  ('1.0', 347, now() - interval '2 days',
    true, false, true,
    true, false,
    'Hi, I''m Aisha and I''m really keen to get started.', true, true,
    '{"source": "data-ops/021 demo seed"}'::jsonb),
  ('1.0', 350, now() - interval '6 hours',
    true, false, false,
    false, true,
    'Hi James here, looking forward to it.', true, false,
    '{"source": "data-ops/021 demo seed"}'::jsonb);

SELECT id, parent_submission_id, cohort_confirmed, l3_mismatch_flag, submitted_at
FROM leads.fastrack_submissions
WHERE parent_submission_id IN (347, 350)
ORDER BY id;
