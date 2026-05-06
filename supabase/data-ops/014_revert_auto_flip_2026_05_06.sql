-- Data fix 014 — revert today's (2026-05-06) auto-flip on 4 enrolments.
-- Date:   2026-05-06
-- Owner:  Charlotte (decided 2026-05-06 — providers haven't actually confirmed
--         these enrolments and we'd rather chase manually before billing).
-- Reason: At 06:00 UTC today, crm.run_enrolment_auto_flip flipped 4 leads
--         from 'open' to 'presumed_enrolled' after the 14-day silence window.
--         Cron logic itself is correct (verified — only acts on status='open',
--         skips enrolled/cannot_reach/lost/presumed/disputed). But operational
--         choice: providers haven't been warned this would happen, and we
--         don't want to start the billing/dispute clock until we've manually
--         chased Andy (Sam) and Heena (Ruby/Laura/Raveena) for actual status.
--
-- Rows reverted:
--   id=245, submission=34, provider=courses-direct, Sam (saamm3194@gmail.com)
--   id=250, submission=49, provider=wyk-digital,    Ruby (rubyislaceramarle@gmail.com)
--   id=251, submission=51, provider=wyk-digital,    Laura (laujhawdon@gmail.com)
--   id=252, submission=53, provider=wyk-digital,    Raveena (raveenapillay02@gmail.com)
--
-- Effect:
--   - status: presumed_enrolled → open
--   - status_updated_at: now()
--   - presumed_deadline_at: NULL (no longer presumed)
--   - dispute_deadline_at: NULL (no dispute window)
--   - Brevo SW_ENROL_STATUS resync: triggered for the 4 submissions so the
--     attribute matches the reverted DB state. Without it, marketing/utility
--     automations that segment on status would still see 'presumed_enrolled'.
--
-- Side note: the 14-day clock is anchored on rl.routed_at, NOT on
--   status_updated_at. So tomorrow's cron would re-flip these unless we
--   either (a) chase + provider posts a status update, or (b) the routed_at
--   itself is amended. We're going with (a). If chasing doesn't produce an
--   answer in time, this script will need to run again at the next 06:00 UTC.
--
-- Follow-up product gap captured separately: warning email to providers at
-- day-12 ("these leads will auto-flip to presumed_enrolled in 2 days unless
-- you update status"). New email type, provider-facing, sister to U4. Belongs
-- in the next round of platform/email rearch work.

BEGIN;

-- 1. Revert the 4 enrolment rows.
UPDATE crm.enrolments
   SET status               = 'open',
       status_updated_at    = now(),
       presumed_deadline_at = NULL,
       dispute_deadline_at  = NULL,
       updated_at           = now()
 WHERE id IN (245, 250, 251, 252);

-- Sanity check: should report 4 rows updated.
-- (psql shows "UPDATE 4" automatically; if you're in Supabase SQL editor and
--  want to verify, run the SELECT below before COMMIT.)

-- 2. Audit log entries — one per row, using the same helper the cron uses
--    so the action timeline is queryable consistently.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id, submission_id, provider_id FROM crm.enrolments
            WHERE id IN (245, 250, 251, 252)
  LOOP
    PERFORM audit.log_system_action(
      p_actor        := 'system:manual:charlotte',
      p_action       := 'manual_revert_to_open',
      p_target_table := 'crm.enrolments',
      p_target_id    := r.id::text,
      p_before       := jsonb_build_object('status', 'presumed_enrolled'),
      p_after        := jsonb_build_object('status', 'open'),
      p_context      := jsonb_build_object(
        'submission_id', r.submission_id,
        'provider_id', r.provider_id,
        'reason', 'reverting today auto-flip for manual provider chase',
        'data_ops_script', '014_revert_auto_flip_2026_05_06'
      )
    );
  END LOOP;
END $$;

-- 3. Brevo resync — push SW_ENROL_STATUS=open back to the 4 contacts so
--    Brevo automations stop treating them as enrolled.
SELECT crm.sync_leads_to_brevo(ARRAY[34, 49, 51, 53]::BIGINT[]);

-- ─── Verification ─────────────────────────────────────────────────────
-- Expect: all 4 rows have status='open', deadlines NULL.
SELECT id, submission_id, provider_id, status,
       status_updated_at, presumed_deadline_at, dispute_deadline_at
  FROM crm.enrolments
 WHERE id IN (245, 250, 251, 252)
 ORDER BY id;

COMMIT;
