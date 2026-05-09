-- Migration 0100 — Daily Brevo attribute reconcile cron
-- Date:    2026-05-09
-- Author:  Claude (platform Session 36) on Charlotte's instruction
-- Reason:  Layer 3 of the DB ↔ Brevo single-source-of-truth architecture
--          (architecture written for Wren in switchable/email/docs/
--          brevo-attribute-architecture.md, 2026-05-09). Layer 1 (Postgres
--          triggers from migrations 0098 + 0099) handles every DB-side
--          write in real-time. Layer 2 (cascade triggers on crm.providers)
--          handles per-provider attribute changes. This migration adds
--          Layer 3: a daily cron that re-fires admin-brevo-resync over
--          every routed-active contact, catching anything that slipped
--          past the triggers (Brevo brief outages, rate-limit retries,
--          matrix.json upstream changes that don't trigger DB writes).
--
--          Cron schedule: 04:45 UTC daily. Sits 15 mins after the existing
--          consent reconcile (04:00 UTC) so they don't overlap.
--
--          Implementation: a SQL helper function
--          crm.run_brevo_attribute_reconcile_daily() chunks the routed-
--          active cohort into batches of 50 and fires crm.sync_leads_to_brevo
--          per chunk. Each chunk dispatches asynchronously via pg_net to
--          admin-brevo-resync; the cron returns immediately while the Edge
--          Function processes in the background. Chunking prevents any
--          single admin-brevo-resync invocation from running long enough
--          to hit the 150s default Edge Function timeout.
--
--          Cohort filter mirrors what the manual sweeps have used today:
--            primary_routed_to IS NOT NULL
--            AND archived_at IS NULL
--            AND COALESCE(is_dq, false) = false
--
--          DQ leads + archived leads are deliberately excluded — their
--          state in Brevo is frozen at DQ/archive time; nothing in the
--          ongoing reconcile loop touches them. Same posture as today's
--          manual sweeps.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: 1 new SECURITY DEFINER function + 1 pg_cron schedule. No
--      table changes, no data migration.
--   2. Readers: function reads leads.submissions to compose the cohort.
--   3. Writers: dispatches async pg_net requests to admin-brevo-resync,
--      which performs Brevo upserts. No direct DB writes.
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. Role/policy: function is SECURITY DEFINER (mirrors crm.sync_leads_to_brevo
--      pattern). pg_cron runs as postgres role, has EXECUTE on this function.
--   7. Rollback: cron.unschedule + DROP FUNCTION (in DOWN section).
--   8. Sign-off: owner (this session, 2026-05-09).
-- Related: 0098 (auto-sync triggers), 0099 (extended triggers + new fields),
--          0081 (consent reconcile cron pattern), brevo-attribute-architecture.md

BEGIN;

-- =============================================================================
-- 1. Helper function — chunks the routed-active cohort into 50s and fires
--    crm.sync_leads_to_brevo per chunk.
-- =============================================================================

CREATE OR REPLACE FUNCTION crm.run_brevo_attribute_reconcile_daily()
RETURNS TABLE(processed_count INT, chunk_count INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm, leads, public, net
AS $$
DECLARE
  v_chunk_size  INT := 50;
  v_offset      INT := 0;
  v_chunk       BIGINT[];
  v_processed   INT := 0;
  v_chunks      INT := 0;
BEGIN
  LOOP
    SELECT array_agg(id ORDER BY id)
      INTO v_chunk
      FROM (
        SELECT id FROM leads.submissions
         WHERE primary_routed_to IS NOT NULL
           AND archived_at IS NULL
           AND COALESCE(is_dq, false) = false
         ORDER BY id
         LIMIT v_chunk_size OFFSET v_offset
      ) t;

    EXIT WHEN v_chunk IS NULL OR array_length(v_chunk, 1) IS NULL;

    PERFORM crm.sync_leads_to_brevo(v_chunk);
    v_processed := v_processed + array_length(v_chunk, 1);
    v_chunks    := v_chunks + 1;
    v_offset    := v_offset + v_chunk_size;
  END LOOP;

  RETURN QUERY SELECT v_processed, v_chunks;
END;
$$;

COMMENT ON FUNCTION crm.run_brevo_attribute_reconcile_daily() IS
  'Daily Brevo attribute reconcile entry point. Chunks the routed-active cohort (primary_routed_to IS NOT NULL, archived_at IS NULL, is_dq=false) into batches of 50 and fires crm.sync_leads_to_brevo per chunk. Each chunk dispatches async via pg_net to admin-brevo-resync. Returns processed count + chunk count for cron log visibility. Layer 3 of the DB ↔ Brevo single-source-of-truth architecture. Added migration 0100.';

REVOKE ALL ON FUNCTION crm.run_brevo_attribute_reconcile_daily() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.run_brevo_attribute_reconcile_daily() TO postgres;

-- =============================================================================
-- 2. Cron schedule — 04:45 UTC daily, 15 mins after the consent reconcile.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'brevo-attribute-reconcile-daily') THEN
    PERFORM cron.unschedule('brevo-attribute-reconcile-daily');
  END IF;
END $$;

SELECT cron.schedule(
  'brevo-attribute-reconcile-daily',
  '45 4 * * *',
  $cmd$ SELECT crm.run_brevo_attribute_reconcile_daily(); $cmd$
);

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DO $$
-- BEGIN
--   IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'brevo-attribute-reconcile-daily') THEN
--     PERFORM cron.unschedule('brevo-attribute-reconcile-daily');
--   END IF;
-- END $$;
-- DROP FUNCTION IF EXISTS crm.run_brevo_attribute_reconcile_daily();
-- COMMIT;
