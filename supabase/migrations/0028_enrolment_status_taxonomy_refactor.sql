-- Migration 0028 — Enrolment status taxonomy refactor
-- Date: 2026-04-26
-- Author: Claude (platform Session 9) with owner sign-off
-- Reason: Owner reframed the status model. Old set
--           open / contacted / enrolled / not_enrolled / presumed_enrolled / disputed
--         was operationally muddy: 'not_enrolled' lumped together "we couldn't
--         reach them" (operational failure) and "we reached them and they said
--         no" (sales failure), and 'contacted' was an intermediate state nobody
--         ever surfaced on the dashboard.
--
--         New model:
--           open / enrolled / presumed_enrolled / cannot_reach / lost
--           + lost_reason (required when status='lost'): not_interested,
--             wrong_course, funding_issue, other.
--           + disputed_at, disputed_reason as flags on presumed_enrolled rows.
--             Disputed is no longer a status — it's a flag that resolves to
--             either enrolled or lost depending on the provider's evidence.
--
--         Why split cannot_reach from lost: the fix is different for each.
--         Cannot reach → better numbers, learner preferred-time field,
--         automated nudges. Lost → qualification, course-fit, funding clarity.
--         Treating them as one number hid where the actual leak was.
--
-- Changes:
--   1. Data migration: rewrite existing rows to the new status set.
--   2. Replace status CHECK constraint.
--   3. Add lost_reason, disputed_at, disputed_reason columns + lost_reason
--      CHECK constraint.
--   4. Replace crm.upsert_enrolment_outcome() to accept lost_reason + dispute
--      fields, validate the new status set, and persist disputes as flags.
--   5. Update crm.run_enrolment_auto_flip() — drop 'contacted' from the
--      early-state filter (it no longer exists).
--
-- Related: platform/supabase/migrations/0022_enrolment_outcome_helper.sql,
--          platform/supabase/migrations/0023_enrolment_auto_flip.sql,
--          platform/docs/changelog.md.

-- UP

-- =============================================================================
-- 1. Data migration — rewrite existing rows to the new status set
-- =============================================================================
-- Order matters: do the column adds first so we can write disputed_at on the
-- same UPDATE that re-statuses old 'disputed' rows.

ALTER TABLE crm.enrolments ADD COLUMN IF NOT EXISTS lost_reason     TEXT;
ALTER TABLE crm.enrolments ADD COLUMN IF NOT EXISTS disputed_at     TIMESTAMPTZ;
ALTER TABLE crm.enrolments ADD COLUMN IF NOT EXISTS disputed_reason TEXT;

-- 'contacted' → 'open'. We never surfaced contacted on the dashboard so no
-- consumer is reading it; folding into 'open' is lossless from the user's
-- view. If a speed-of-contact metric is wanted later, capture it via a
-- dedicated timestamp column rather than reviving the status.
UPDATE crm.enrolments SET status = 'open' WHERE status = 'contacted';

-- 'not_enrolled' → 'lost' with lost_reason NULL. We have no structured signal
-- in the historical 'notes' free-text to retrofit reasons reliably. Owner can
-- backfill manually for the few rows that exist today if she wants. Going
-- forward every 'lost' row will carry a reason via the form.
UPDATE crm.enrolments SET status = 'lost' WHERE status = 'not_enrolled';

-- 'disputed' → 'presumed_enrolled' + flag fields. The dispute is now a flag,
-- not a status. We snapshot status_updated_at as disputed_at (best signal we
-- have) and copy notes into disputed_reason as a starting point. The original
-- dispute_deadline_at is preserved (it sits in its existing column).
UPDATE crm.enrolments
   SET status          = 'presumed_enrolled',
       disputed_at     = COALESCE(disputed_at, status_updated_at, updated_at, now()),
       disputed_reason = COALESCE(disputed_reason, notes)
 WHERE status = 'disputed';

-- =============================================================================
-- 2. Replace status CHECK constraint
-- =============================================================================

ALTER TABLE crm.enrolments DROP CONSTRAINT IF EXISTS enrolments_status_chk;
ALTER TABLE crm.enrolments
  ADD CONSTRAINT enrolments_status_chk
  CHECK (status IN ('open', 'enrolled', 'presumed_enrolled', 'cannot_reach', 'lost'));

-- =============================================================================
-- 3. lost_reason CHECK constraint
-- =============================================================================
-- NULL-permitted (cannot_reach has no reason; legacy 'lost' rows without
-- backfill stay NULL). Going forward, the form requires a value when status
-- is set to 'lost'; the function below enforces it.

ALTER TABLE crm.enrolments DROP CONSTRAINT IF EXISTS enrolments_lost_reason_chk;
ALTER TABLE crm.enrolments
  ADD CONSTRAINT enrolments_lost_reason_chk
  CHECK (
    lost_reason IS NULL
    OR lost_reason IN ('not_interested', 'wrong_course', 'funding_issue', 'other')
  );

-- =============================================================================
-- 4. Replace crm.upsert_enrolment_outcome() with the new signature
-- =============================================================================
-- Signature change: drop the old 3-arg version, add a 5-arg version that
-- accepts lost_reason + dispute fields. Server Action layer updates in lockstep.

DROP FUNCTION IF EXISTS crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION crm.upsert_enrolment_outcome(
  p_submission_id    BIGINT,
  p_status           TEXT,
  p_notes            TEXT DEFAULT NULL,
  p_lost_reason      TEXT DEFAULT NULL,
  p_disputed         BOOLEAN DEFAULT FALSE,
  p_disputed_reason  TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm, leads, audit, admin, public
AS $$
DECLARE
  v_enrolment_id   BIGINT;
  v_provider_id    TEXT;
  v_routed_at      TIMESTAMPTZ;
  v_routing_log_id BIGINT;
  v_existing       crm.enrolments%ROWTYPE;
  v_before         JSONB;
  v_after          JSONB;
  v_disputed_at    TIMESTAMPTZ;
BEGIN
  -- Caller must be admin
  IF NOT admin.is_admin() THEN
    RAISE EXCEPTION 'Only admins can mark enrolment outcomes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Validate status against the new canonical set. CHECK constraint also
  -- enforces this at the table level; failing here gives a cleaner Server
  -- Action error.
  IF p_status NOT IN ('open', 'enrolled', 'presumed_enrolled', 'cannot_reach', 'lost') THEN
    RAISE EXCEPTION 'Invalid outcome status %: must be one of open, enrolled, presumed_enrolled, cannot_reach, lost', p_status
      USING ERRCODE = 'check_violation';
  END IF;

  -- 'lost' requires a reason. The form enforces this client-side too, but the
  -- function holds the line if a Server Action is bypassed.
  IF p_status = 'lost' AND (p_lost_reason IS NULL OR length(trim(p_lost_reason)) = 0) THEN
    RAISE EXCEPTION 'lost_reason is required when status=''lost'' (one of: not_interested, wrong_course, funding_issue, other)'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_lost_reason IS NOT NULL
     AND p_lost_reason NOT IN ('not_interested', 'wrong_course', 'funding_issue', 'other') THEN
    RAISE EXCEPTION 'Invalid lost_reason %: must be one of not_interested, wrong_course, funding_issue, other', p_lost_reason
      USING ERRCODE = 'check_violation';
  END IF;

  -- Disputes only make sense on presumed_enrolled. If the caller raises the
  -- flag against a different status, fail loudly — UX bug if it ever reaches
  -- the function.
  IF p_disputed AND p_status <> 'presumed_enrolled' THEN
    RAISE EXCEPTION 'Disputes can only be raised against presumed_enrolled rows (got status=%)', p_status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Find routing context (most recent routing_log row per submission)
  SELECT id, provider_id, routed_at
    INTO v_routing_log_id, v_provider_id, v_routed_at
    FROM leads.routing_log
   WHERE submission_id = p_submission_id
   ORDER BY routed_at DESC
   LIMIT 1;

  IF v_provider_id IS NULL THEN
    RAISE EXCEPTION 'Submission % has no routing_log entry. Route the lead before marking an enrolment outcome.', p_submission_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Capture existing row for audit
  SELECT *
    INTO v_existing
    FROM crm.enrolments
   WHERE submission_id = p_submission_id
     AND provider_id   = v_provider_id
   LIMIT 1;

  -- Compute disputed_at: if raising a dispute and no prior dispute timestamp,
  -- set to now(). If clearing the flag (p_disputed=false), preserve any
  -- historical disputed_at as evidence the dispute existed — clearing here
  -- would erase audit-relevant state.
  v_disputed_at := CASE
    WHEN p_disputed AND v_existing.disputed_at IS NULL THEN now()
    WHEN p_disputed THEN v_existing.disputed_at
    ELSE v_existing.disputed_at
  END;

  -- UPSERT. Status-dependent column writes:
  --   - lost_reason: only set when status='lost', otherwise NULL it (a row
  --     moving from lost back to open shouldn't keep an orphan reason)
  --   - disputed_at / disputed_reason: only meaningful on presumed_enrolled,
  --     but kept on the row when status moves on to enrolled/lost as audit
  --     evidence. We do NOT clear them when transitioning out of presumed.
  INSERT INTO crm.enrolments (
    submission_id, routing_log_id, provider_id, status,
    sent_to_provider_at, status_updated_at, notes,
    lost_reason, disputed_at, disputed_reason
  ) VALUES (
    p_submission_id, v_routing_log_id, v_provider_id, p_status,
    v_routed_at, now(), p_notes,
    CASE WHEN p_status = 'lost' THEN p_lost_reason ELSE NULL END,
    v_disputed_at,
    CASE WHEN p_disputed THEN p_disputed_reason ELSE NULL END
  )
  ON CONFLICT (submission_id, provider_id) DO UPDATE SET
    status            = EXCLUDED.status,
    status_updated_at = now(),
    notes             = EXCLUDED.notes,
    lost_reason       = EXCLUDED.lost_reason,
    disputed_at       = EXCLUDED.disputed_at,
    disputed_reason   = CASE
      WHEN p_disputed THEN EXCLUDED.disputed_reason
      ELSE crm.enrolments.disputed_reason
    END,
    updated_at        = now()
  RETURNING id INTO v_enrolment_id;

  -- Audit
  v_before := CASE
    WHEN v_existing.id IS NOT NULL THEN jsonb_build_object(
      'status',          v_existing.status,
      'notes',           v_existing.notes,
      'lost_reason',     v_existing.lost_reason,
      'disputed_at',     v_existing.disputed_at,
      'disputed_reason', v_existing.disputed_reason
    )
    ELSE NULL
  END;
  v_after := jsonb_build_object(
    'status',          p_status,
    'notes',           p_notes,
    'lost_reason',     CASE WHEN p_status = 'lost' THEN p_lost_reason ELSE NULL END,
    'disputed_at',     v_disputed_at,
    'disputed_reason', CASE WHEN p_disputed THEN p_disputed_reason ELSE NULL END
  );

  PERFORM audit.log_action(
    p_action       := 'mark_enrolment_outcome',
    p_target_table := 'crm.enrolments',
    p_target_id    := v_enrolment_id::text,
    p_before       := v_before,
    p_after        := v_after,
    p_context      := jsonb_build_object(
      'submission_id', p_submission_id,
      'provider_id',   v_provider_id
    ),
    p_surface      := 'admin'
  );

  RETURN v_enrolment_id;
END;
$$;

COMMENT ON FUNCTION crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT, TEXT, BOOLEAN, TEXT) IS
  'Sets the enrolment outcome for a routed lead under the new taxonomy (open/enrolled/presumed_enrolled/cannot_reach/lost). Validates lost_reason on lost rows; persists disputes as flags on presumed_enrolled. Atomic with audit. Replaces the 3-arg version from migration 0022. Added migration 0028.';

REVOKE ALL ON FUNCTION crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT, TEXT, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT, TEXT, BOOLEAN, TEXT) TO authenticated;

-- =============================================================================
-- 5. Replace crm.run_enrolment_auto_flip() — drop 'contacted' from early-state
-- =============================================================================
-- Same body as migration 0023 with 'contacted' removed from the skip-check.
-- Keeping the rewrite explicit so future readers see the change in one place.

CREATE OR REPLACE FUNCTION crm.run_enrolment_auto_flip()
RETURNS TABLE(flipped_count INTEGER, sample_submission_ids BIGINT[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm, leads, audit, public
AS $$
DECLARE
  r                    RECORD;
  v_flipped            INTEGER := 0;
  v_sample             BIGINT[] := ARRAY[]::BIGINT[];
  v_dispute_deadline   TIMESTAMPTZ := now() + INTERVAL '7 days';
  v_existing           crm.enrolments%ROWTYPE;
  v_enrolment_id       BIGINT;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (rl.submission_id)
      rl.id          AS routing_log_id,
      rl.submission_id,
      rl.provider_id,
      rl.routed_at
      FROM leads.routing_log rl
      JOIN leads.submissions s ON s.id = rl.submission_id
     WHERE rl.routed_at < now() - INTERVAL '14 days'
       AND s.is_dq = false
       AND s.archived_at IS NULL
     ORDER BY rl.submission_id, rl.routed_at DESC
  LOOP
    SELECT *
      INTO v_existing
      FROM crm.enrolments
     WHERE submission_id = r.submission_id
       AND provider_id   = r.provider_id
     LIMIT 1;

    -- Only flip rows that are NULL or 'open'. Terminal states (enrolled, lost,
    -- cannot_reach) and the already-flipped state (presumed_enrolled) are
    -- left alone.
    IF v_existing.id IS NOT NULL
       AND v_existing.status <> 'open' THEN
      CONTINUE;
    END IF;

    INSERT INTO crm.enrolments (
      submission_id, routing_log_id, provider_id, status,
      sent_to_provider_at, status_updated_at,
      presumed_deadline_at, dispute_deadline_at
    ) VALUES (
      r.submission_id, r.routing_log_id, r.provider_id, 'presumed_enrolled',
      r.routed_at, now(),
      now(), v_dispute_deadline
    )
    ON CONFLICT (submission_id, provider_id) DO UPDATE SET
      status               = 'presumed_enrolled',
      status_updated_at    = now(),
      presumed_deadline_at = now(),
      dispute_deadline_at  = v_dispute_deadline,
      updated_at           = now()
    RETURNING id INTO v_enrolment_id;

    PERFORM audit.log_system_action(
      p_actor        := 'system:cron:enrolment-auto-flip',
      p_action       := 'auto_flip_to_presumed_enrolled',
      p_target_table := 'crm.enrolments',
      p_target_id    := v_enrolment_id::text,
      p_before       := CASE
        WHEN v_existing.id IS NOT NULL
          THEN jsonb_build_object('status', v_existing.status)
        ELSE NULL
      END,
      p_after        := jsonb_build_object(
        'status', 'presumed_enrolled',
        'dispute_deadline_at', v_dispute_deadline
      ),
      p_context      := jsonb_build_object(
        'submission_id',     r.submission_id,
        'provider_id',       r.provider_id,
        'routed_at',         r.routed_at,
        'days_since_routed', EXTRACT(DAY FROM now() - r.routed_at)::INT
      )
    );

    v_flipped := v_flipped + 1;
    IF coalesce(array_length(v_sample, 1), 0) < 10 THEN
      v_sample := array_append(v_sample, r.submission_id);
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_flipped, v_sample;
END;
$$;

-- =============================================================================
-- 6. Migration summary
-- =============================================================================

DO $$
DECLARE
  v_open      INT;
  v_enrolled  INT;
  v_presumed  INT;
  v_cannot    INT;
  v_lost      INT;
  v_disputed  INT;
BEGIN
  SELECT COUNT(*) INTO v_open      FROM crm.enrolments WHERE status = 'open';
  SELECT COUNT(*) INTO v_enrolled  FROM crm.enrolments WHERE status = 'enrolled';
  SELECT COUNT(*) INTO v_presumed  FROM crm.enrolments WHERE status = 'presumed_enrolled';
  SELECT COUNT(*) INTO v_cannot    FROM crm.enrolments WHERE status = 'cannot_reach';
  SELECT COUNT(*) INTO v_lost      FROM crm.enrolments WHERE status = 'lost';
  SELECT COUNT(*) INTO v_disputed  FROM crm.enrolments WHERE disputed_at IS NOT NULL;
  RAISE NOTICE 'Status taxonomy migration complete: open=% enrolled=% presumed=% cannot_reach=% lost=% (disputed flag set on % rows)',
    v_open, v_enrolled, v_presumed, v_cannot, v_lost, v_disputed;
END $$;

-- DOWN
-- -- This is destructive: reverting requires repopulating 'contacted' /
-- -- 'not_enrolled' / 'disputed' which are not preserved on the row. The
-- -- audit trail is the only canonical history. Restore from a pre-migration
-- -- backup if a true revert is needed.
-- --
-- -- Forward-only ops:
-- -- ALTER TABLE crm.enrolments DROP CONSTRAINT IF EXISTS enrolments_lost_reason_chk;
-- -- ALTER TABLE crm.enrolments DROP COLUMN IF EXISTS disputed_reason;
-- -- ALTER TABLE crm.enrolments DROP COLUMN IF EXISTS disputed_at;
-- -- ALTER TABLE crm.enrolments DROP COLUMN IF EXISTS lost_reason;
-- -- ALTER TABLE crm.enrolments DROP CONSTRAINT IF EXISTS enrolments_status_chk;
-- -- ALTER TABLE crm.enrolments
-- --   ADD CONSTRAINT enrolments_status_chk
-- --   CHECK (status IN ('open', 'contacted', 'enrolled', 'not_enrolled', 'presumed_enrolled', 'disputed'));
-- -- DROP FUNCTION IF EXISTS crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT, TEXT, BOOLEAN, TEXT);
-- -- (Then recreate the migration 0022 / 0023 versions of upsert_enrolment_outcome
-- --  and run_enrolment_auto_flip from those files.)
