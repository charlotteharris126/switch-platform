-- Migration 0042 — crm.ensure_open_enrolment helper
-- Date: 2026-04-30
-- Author: Claude (platform session) with owner sign-off
-- Reason: Every routed lead should have an enrolment row from the moment it
-- is routed, so reports that join `crm.enrolments` see the full denominator
-- (open + enrolled + presumed_enrolled + cannot_reach + lost). Today
-- `route-lead.ts` writes `leads.routing_log` and updates
-- `leads.submissions.primary_routed_to`, but does NOT insert into
-- `crm.enrolments` — so a routed lead is invisible to enrolment reports
-- until either the owner manually marks an outcome via
-- `crm.upsert_enrolment_outcome` or the 14-day auto-flip
-- (`crm.run_enrolment_auto_flip`) inserts a presumed_enrolled row. Result on
-- 2026-04-30: 16 enrolment rows for 113 routed leads (95 active routed
-- parents have no row).
--
-- This migration ships the going-forward fix only — the function itself,
-- granted to functions_writer (Edge Function role) and authenticated (admin
-- dashboard role). The Edge Function update in
-- `platform/supabase/functions/_shared/route-lead.ts` calls it inside the
-- routing transaction so every newly routed lead atomically gets an open
-- row alongside the routing_log insert.
--
-- The 91-row historical backfill ships separately as a follow-up data-fix
-- migration (0043) once this function is live and verified producing rows
-- for new routes.
--
-- Behaviour:
--   - Idempotent. Re-call with the same (submission_id, provider_id) is a
--     no-op via ON CONFLICT DO NOTHING. Always returns the enrolment row id
--     whether newly inserted or pre-existing. Safe for the backfill (which
--     is allowed to skip the 16 leads that already have rows from outcome
--     RPC / auto-flip).
--   - SECURITY DEFINER so the calling role (functions_writer at runtime,
--     postgres at backfill time) doesn't need INSERT on crm.enrolments.
--     Matches the pattern of `crm.upsert_enrolment_outcome` (migration
--     0028). functions_writer has zero grants on crm.enrolments today; we
--     deliberately keep it that way and route writes through this RPC.
--   - sent_to_provider_at sourced from leads.routing_log.routed_at. This
--     matters for the backfill: historical rows must keep their original
--     route timestamp, not `now()`. For new routes the routing_log row was
--     inserted microseconds before this call so the timestamp is
--     effectively `now()` either way.
--
-- Related:
--   - platform/supabase/functions/_shared/route-lead.ts (caller)
--   - platform/supabase/migrations/0028_enrolment_status_taxonomy_refactor.sql
--     (status taxonomy + upsert_enrolment_outcome pattern this mirrors)
--   - platform/supabase/migrations/0001_init_pilot_schemas.sql
--     (crm.enrolments definition + (submission_id, provider_id) unique
--     constraint that ON CONFLICT relies on)
--   - platform/docs/data-architecture.md (crm.enrolments section — add a
--     note that 'open' rows are auto-created at routing time as of this
--     migration)
--   - platform/docs/changelog.md

-- UP

CREATE OR REPLACE FUNCTION crm.ensure_open_enrolment(
  p_submission_id  BIGINT,
  p_routing_log_id BIGINT,
  p_provider_id    TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm, leads, public
AS $$
DECLARE
  v_enrolment_id BIGINT;
  v_routed_at    TIMESTAMPTZ;
BEGIN
  SELECT routed_at INTO v_routed_at
    FROM leads.routing_log
   WHERE id = p_routing_log_id;

  IF v_routed_at IS NULL THEN
    v_routed_at := now();
  END IF;

  INSERT INTO crm.enrolments (
    submission_id, routing_log_id, provider_id, status,
    sent_to_provider_at, status_updated_at
  ) VALUES (
    p_submission_id, p_routing_log_id, p_provider_id, 'open',
    v_routed_at, now()
  )
  ON CONFLICT (submission_id, provider_id) DO NOTHING
  RETURNING id INTO v_enrolment_id;

  -- ON CONFLICT DO NOTHING leaves v_enrolment_id NULL when a row already
  -- exists. Fetch it so the caller always gets a non-NULL id back.
  IF v_enrolment_id IS NULL THEN
    SELECT id INTO v_enrolment_id
      FROM crm.enrolments
     WHERE submission_id = p_submission_id
       AND provider_id   = p_provider_id;
  END IF;

  RETURN v_enrolment_id;
END;
$$;

COMMENT ON FUNCTION crm.ensure_open_enrolment(BIGINT, BIGINT, TEXT) IS
  'Atomically creates an open enrolment row for a freshly routed lead, or returns the existing row id if one is already present. Idempotent. Called from route-lead.ts inside the routing transaction (and from the 0043 backfill). Added migration 0042.';

REVOKE ALL ON FUNCTION crm.ensure_open_enrolment(BIGINT, BIGINT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.ensure_open_enrolment(BIGINT, BIGINT, TEXT) TO functions_writer;
GRANT EXECUTE ON FUNCTION crm.ensure_open_enrolment(BIGINT, BIGINT, TEXT) TO authenticated;

-- DOWN
-- DROP FUNCTION IF EXISTS crm.ensure_open_enrolment(BIGINT, BIGINT, TEXT);
