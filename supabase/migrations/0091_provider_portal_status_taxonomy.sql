-- Migration 0091 — Provider portal: expanded status taxonomy
-- Date:    2026-05-08
-- Author:  Claude (platform Session 36) on Charlotte's instruction
-- Reason:  Provider portal MVP introduces per-attempt outcome buttons
--          (Attempt 1 / 2 / 3 no answer) and an intermediate "enrolment
--          meeting booked" state. The CHECK constraint on crm.enrolments.status
--          must allow these new values. Same migration also drops the legacy
--          'contacted' value: zero production rows use it (verified
--          2026-05-08), and four code paths referencing it are either paused
--          (HubSpot integration, sheet mirror Channel B) or stale UI listings
--          getting cleaned up alongside this migration. DB stays the single
--          source of truth for the status taxonomy — TypeScript types in the
--          portal app derive from this constraint, never define their own list.
-- Related: platform/docs/provider-portal-mvp-scoping.md
--          migration 0028 (previous status taxonomy refactor)
--          migration 0080 (paused auto-flip — reversed in 0095)
--          .claude/rules/data-infrastructure.md (one logical change per migration)

-- UP

-- Drop the existing CHECK so we can replace it with the expanded set.
-- Cleaner than ALTER ... ADD VALUE because this is a TEXT column with a
-- CHECK, not an ENUM.
ALTER TABLE crm.enrolments
  DROP CONSTRAINT IF EXISTS enrolments_status_check;

ALTER TABLE crm.enrolments
  ADD CONSTRAINT enrolments_status_check CHECK (status IN (
    -- Initial state set on routing
    'open',
    -- Provider-driven: each attempt fires a chaser email to the learner
    'attempt_1_no_answer',
    'attempt_2_no_answer',
    'attempt_3_no_answer',
    -- Provider-driven: confirms a learner has an enrolment meeting booked
    'enrolment_meeting_booked',
    -- Terminal states
    'enrolled',
    'lost',
    'cannot_reach',
    -- System-set only (auto-flip cron on day 14 from routing for ghosted leads)
    'presumed_enrolled'
  ));

COMMENT ON CONSTRAINT enrolments_status_check ON crm.enrolments IS
  'Status taxonomy as of 2026-05-08 (migration 0091). open is the initial state on routing. attempt_1/2/3_no_answer fire chaser emails. enrolment_meeting_booked is intermediate-but-engaged. enrolled / lost / cannot_reach are provider-set terminals. presumed_enrolled is system-set by the day-14 auto-flip cron and only applies to ghosted (status=open) leads.';

-- DOWN
-- Restoring 'contacted' is harmless if no rows have re-acquired the new
-- statuses; if any rows are at attempt_1/2/3/enrolment_meeting_booked,
-- the down migration must include a data fix step first (e.g. set them
-- back to 'open' or 'contacted' depending on intent).
--
-- ALTER TABLE crm.enrolments DROP CONSTRAINT enrolments_status_check;
-- ALTER TABLE crm.enrolments ADD CONSTRAINT enrolments_status_check
--   CHECK (status IN ('open','contacted','enrolled','presumed_enrolled','lost','cannot_reach'));
