-- Migration 0097 — Re-enable auto-flip + day-12 warning crons
-- Date:    2026-05-09
-- Author:  Claude (platform Session 36) on Charlotte's instruction
-- Reason:  Reverses the 2026-05-06 / 2026-05-07 deferred-indefinitely
--          decisions (migration 0080 paused the auto-flip; the day-12
--          warning was unscheduled manually around the same time). Provider
--          portal MVP brings both back online with one narrowing rule:
--          the auto-flip only fires for leads still at status='open' on
--          day 14 (the function body already enforces this — the
--          v_existing.status <> 'open' check). Engaged statuses
--          (attempt_1/2/3, enrolment_meeting_booked) are left alone.
--          Day-12 warning email gives providers 2 days notice before any
--          flip, no PII (count + portal link only) per the
--          provider-emails-no-PII rule.
--
--          Function bodies are unchanged. This migration is purely
--          cron.schedule re-enablement, idempotent against any current
--          scheduled state.
--
--          Both crons depend on Brevo templates that are not yet set:
--            - email-presumed-warning-cron-daily needs
--              BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING in Supabase Vault.
--              Without it the cron runs and exits early with reason
--              "BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING env not set" —
--              harmless dormant state.
--            - enrolment-auto-flip-daily has no email step itself; the
--              corresponding "X leads have flipped to presumed_enrolled"
--              confirmation email + the day-19 dispute reminder will be
--              wired when those templates are written (cross-project push
--              to Wren this session).
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: pg_cron schedule entries. No table change. Function bodies
--      unchanged.
--   2. Readers: enrolment-auto-flip reads leads.routing_log + crm.enrolments,
--      writes to crm.enrolments + audit.actions (existing flow).
--      email-presumed-warning-cron reads same plus crm.providers, writes
--      to crm.email_log + Brevo (existing flow, was previously scheduled by
--      migration 0085).
--   3. Writers: same as reads above.
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role/policy: existing grants, no change.
--   7. Rollback: cron.unschedule both jobs (in DOWN).
--   8. Sign-off: owner (this session, 2026-05-08/09 — explicit reversal of
--      the 2026-05-06 / 2026-05-07 deferred decisions).
-- Related: migration 0023 (originally scheduled auto-flip), 0080 (paused),
--          0085 (originally scheduled the day-12 warning), 0090 (pre-flight
--          dependencies), platform/docs/provider-portal-mvp-scoping.md

-- UP

-- Idempotent: drop any existing schedule with these names first so re-running
-- the migration against a partially-scheduled state is safe.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'enrolment-auto-flip-daily') THEN
    PERFORM cron.unschedule('enrolment-auto-flip-daily');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-presumed-warning-cron-daily') THEN
    PERFORM cron.unschedule('email-presumed-warning-cron-daily');
  END IF;
END $$;

-- Auto-flip: 06:00 UTC daily. Same schedule as migration 0023 originally set.
SELECT cron.schedule(
  'enrolment-auto-flip-daily',
  '0 6 * * *',
  $$SELECT crm.run_enrolment_auto_flip();$$
);

-- Day-12 warning: 05:00 UTC daily. Same schedule as migration 0085 set.
-- Runs an hour before the auto-flip so it can't ever email "your leads
-- will flip in 2 days" on the same morning the flip would actually fire.
SELECT cron.schedule(
  'email-presumed-warning-cron-daily',
  '0 5 * * *',
  $cmd$
    SELECT net.http_post(
      url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/email-presumed-warning-cron',
      headers := jsonb_build_object(
        'x-audit-key', public.get_shared_secret('AUDIT_SHARED_SECRET'),
        'content-type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cmd$
);

-- DOWN
-- DO $$
-- BEGIN
--   IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-presumed-warning-cron-daily') THEN
--     PERFORM cron.unschedule('email-presumed-warning-cron-daily');
--   END IF;
--   IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'enrolment-auto-flip-daily') THEN
--     PERFORM cron.unschedule('enrolment-auto-flip-daily');
--   END IF;
-- END $$;
