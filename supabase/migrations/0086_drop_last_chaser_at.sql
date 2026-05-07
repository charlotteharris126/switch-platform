-- Migration 0086 — drop crm.enrolments.last_chaser_at, derive from email_log
-- Date: 2026-05-07
-- Author: Claude (platform Session 34) with owner sign-off
-- Reason: Phase 4 closeout of email platform rearchitecture (spec at
--   platform/docs/email-platform-rearchitecture-spec.md). The
--   last_chaser_at column duplicated state that crm.email_log records
--   per-send. Two writers existed: this column from
--   crm.fire_provider_chaser (synchronous), the email_log row from
--   admin-brevo-chase via sendTransactional (async via pg_net). Drift
--   risk was real: a pg_net call failure left last_chaser_at stamped
--   while no email_log row existed, lying to the dashboard.
--
--   The spec deferred this choice to Phase 4 between (a) drop column or
--   (b) GENERATED ALWAYS AS expression. Postgres generated columns can
--   only reference other columns in the same row — they cannot reference
--   another table's aggregate — so option (b) was unimplementable. Drop
--   + read-time derivation is the only real option.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: backfill historical chaser sends into crm.email_log,
--      add view crm.vw_enrolments_chaser_state for read-time derivation,
--      modify crm.fire_provider_chaser to stop stamping last_chaser_at,
--      drop column crm.enrolments.last_chaser_at.
--   2. Readers affected: app/admin/leads/page.tsx (table column) and
--      app/admin/layout.tsx (badge counts). Both updated in the same
--      session — page.tsx derives from the email_log map it already
--      loads; layout.tsx queries the new view.
--   3. Writers affected: crm.fire_provider_chaser only; rewritten in
--      this migration to drop the UPDATE on enrolments.last_chaser_at.
--      admin-brevo-chase already writes the canonical email_log row via
--      sendTransactional and needs no change.
--   4. Schema version: not affected (internal column).
--   5. Data migration: synthesise email_log rows for any enrolments with
--      last_chaser_at IS NOT NULL that have no matching chaser_funded /
--      chaser_self row in email_log at the same triggered_at. Type
--      chosen by submission's funding_category. template_id placeholder
--      '__backfill__' since historical sends went through Brevo
--      automations not the transactional API. metadata.backfill=true so
--      analytics can filter.
--   6. Role/policy: GRANT SELECT on the new view to authenticated and
--      readonly_analytics. View inherits RLS from underlying tables.
--   7. Rollback: DOWN re-adds the column, repopulates last_chaser_at
--      from MAX(triggered_at) of chaser email_log rows, restores the
--      original fire_provider_chaser body, drops the view.
--   8. Sign-off: owner (this session, 2026-05-07).
--
-- Related:
--   platform/docs/email-platform-rearchitecture-spec.md (Phase 4)
--   platform/supabase/migrations/0046_chaser_tracking.sql (original add)
--   platform/supabase/migrations/0073_crm_email_log.sql (email_log table)
--   platform/supabase/migrations/0078_email_log_chaser_split.sql (chaser type split)

BEGIN;

-- 1. Backfill: synthesise email_log rows for any historical chaser sends
--    that pre-date Phase 2's dual-write window or were stamped without a
--    matching email_log row (pg_net invocation failure path). NOT EXISTS
--    guards against double-inserting where the dual-write already wrote
--    a real row.
INSERT INTO crm.email_log (
  submission_id,
  email_type,
  channel,
  template_id,
  recipient_email,
  triggered_at,
  sent_at,
  status,
  metadata
)
SELECT
  e.submission_id,
  CASE
    WHEN s.funding_category = 'self'              THEN 'chaser_self'
    WHEN s.funding_category IN ('gov', 'loan')    THEN 'chaser_funded'
    -- Apprenticeship + NULL + future categories default to chaser_funded
    -- because the historical chaser was a single funded-shape Brevo
    -- automation. The metadata.funding_category_at_backfill field below
    -- preserves the original value for analytics filters that need to
    -- exclude or re-bucket these rows.
    ELSE 'chaser_funded'
  END,
  'transactional',
  '__backfill__',
  s.email,
  e.last_chaser_at,
  e.last_chaser_at,
  'sent',
  jsonb_build_object(
    'backfill', true,
    'source', '0086_drop_last_chaser_at',
    'funding_category_at_backfill', s.funding_category,
    'note', 'synthesised from enrolments.last_chaser_at; original delivery via Brevo automation list-add'
  )
FROM crm.enrolments e
JOIN leads.submissions s ON s.id = e.submission_id
WHERE e.last_chaser_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM crm.email_log el
     WHERE el.submission_id = e.submission_id
       AND el.email_type IN ('chaser_funded', 'chaser_self')
       AND el.triggered_at = e.last_chaser_at
  );

-- 2. Rewrite fire_provider_chaser to drop the last_chaser_at UPDATE.
--    Function keeps eligibility filtering, audit log, and pg_net call
--    into admin-brevo-chase. The Edge Function's sendTransactional call
--    writes the canonical email_log row.
CREATE OR REPLACE FUNCTION crm.fire_provider_chaser(p_submission_ids BIGINT[])
RETURNS TABLE(submission_id BIGINT, email TEXT, status TEXT, reason TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm, leads, audit, public, net
AS $$
DECLARE
  r              RECORD;
  v_secret       TEXT;
  v_url          TEXT := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/admin-brevo-chase';
  v_emails       TEXT[] := ARRAY[]::TEXT[];
  v_fired_ids    BIGINT[] := ARRAY[]::BIGINT[];
  v_req_id       BIGINT;
BEGIN
  IF p_submission_ids IS NULL OR array_length(p_submission_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT
      s.id          AS sub_id,
      s.email       AS email,
      s.archived_at AS archived_at,
      s.is_dq       AS is_dq,
      e.id          AS enrol_id,
      e.provider_id AS provider_id,
      e.status      AS enrol_status
    FROM unnest(p_submission_ids) WITH ORDINALITY AS x(sub_id, ord)
    JOIN leads.submissions s ON s.id = x.sub_id
    LEFT JOIN crm.enrolments e ON e.submission_id = s.id
    ORDER BY x.ord
  LOOP
    IF r.email IS NULL OR r.email = '' THEN
      submission_id := r.sub_id; email := NULL; status := 'skipped';
      reason := 'no email';
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF r.archived_at IS NOT NULL THEN
      submission_id := r.sub_id; email := r.email; status := 'skipped';
      reason := 'archived';
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF r.enrol_id IS NULL THEN
      submission_id := r.sub_id; email := r.email; status := 'skipped';
      reason := 'no enrolment row (lead never routed)';
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- Touch updated_at so any "last modified" reader (Metabase
    -- dashboards, last-touched ordering, etc.) still sees the chaser
    -- fire reflected in the row's modification time. Migration 0046
    -- did this alongside the last_chaser_at stamp; we keep this side-
    -- effect even though the column itself is gone.
    UPDATE crm.enrolments
       SET updated_at = now()
     WHERE id = r.enrol_id;

    -- Audit the chaser-fire intent. The actual send + canonical email_log
    -- row is written by admin-brevo-chase (Edge Function) via
    -- sendTransactional. No direct enrolments column to update — chaser
    -- state lives in email_log from migration 0086 onward.
    PERFORM audit.log_action(
      p_action       := 'fire_provider_chaser',
      p_target_table := 'crm.enrolments',
      p_target_id    := r.enrol_id::text,
      p_before       := NULL,
      p_after        := jsonb_build_object('chaser_fired_at', now()),
      p_context      := jsonb_build_object(
        'submission_id', r.sub_id,
        'provider_id',   r.provider_id,
        'enrol_status',  r.enrol_status
      ),
      p_surface      := 'admin'
    );

    v_emails := array_append(v_emails, lower(r.email));
    v_fired_ids := array_append(v_fired_ids, r.sub_id);

    submission_id := r.sub_id; email := r.email; status := 'ok';
    reason := NULL;
    RETURN NEXT;
  END LOOP;

  IF array_length(v_emails, 1) > 0 THEN
    v_secret := public.get_shared_secret('AUDIT_SHARED_SECRET');
    SELECT net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-audit-key',  v_secret
      ),
      body    := jsonb_build_object(
        'emails',        to_jsonb(v_emails),
        'submissionIds', to_jsonb(v_fired_ids)
      ),
      timeout_milliseconds := 60000
    ) INTO v_req_id;
  END IF;

  RETURN;
END;
$$;

COMMENT ON FUNCTION crm.fire_provider_chaser(BIGINT[]) IS
  'Bulk-fires the SF2 Provider-tried-no-answer Brevo chaser for the given submission ids. Audits intent and async-fires admin-brevo-chase via pg_net. The Edge Function calls sendTransactional which writes the canonical email_log row. Returns per-id status (ok / skipped + reason). Migration 0086 (Phase 4 closeout) removed the redundant crm.enrolments.last_chaser_at stamp; email_log is now sole source of truth.';

-- 3. Drop the column. Must happen BEFORE the view is created — otherwise
--    the view's `e.*` selects last_chaser_at and Postgres refuses to
--    drop the column because the view depends on it.
ALTER TABLE crm.enrolments DROP COLUMN last_chaser_at;

-- 4. Read-time derivation view. Each enrolment row exposes the latest
--    successful chaser send (sent / delivered / opened / clicked) as
--    latest_chaser_at, NULL if never chased. Created AFTER the column
--    drop so `e.*` naturally excludes the now-gone last_chaser_at.
--    View inherits RLS from crm.enrolments + crm.email_log via
--    security_invoker=true (Postgres 15+ feature) — underlying-table RLS
--    runs as the querying role, not the view owner.
CREATE VIEW crm.vw_enrolments_chaser_state
WITH (security_invoker = true) AS
SELECT
  e.*,
  (
    SELECT MAX(el.triggered_at)
      FROM crm.email_log el
     WHERE el.submission_id = e.submission_id
       AND el.email_type IN ('chaser_funded', 'chaser_self')
       AND el.status IN ('sent', 'delivered', 'opened', 'clicked')
  ) AS latest_chaser_at
FROM crm.enrolments e;

COMMENT ON VIEW crm.vw_enrolments_chaser_state IS
  'Drop-in replacement for crm.enrolments reads that need a "when was the chaser last sent" column. Exposes every enrolments column (e.*) plus a derived latest_chaser_at from MAX(triggered_at) over chaser_funded / chaser_self email_log rows in healthy delivery states (sent / delivered / opened / clicked). security_invoker=true means underlying-table RLS runs as the querying role, not the view owner — so admin reads still go through admin.is_admin() and analytics reads through readonly_analytics policies. Replaces the dropped crm.enrolments.last_chaser_at column. Used by app/admin/layout.tsx badge counts, app/admin/leads/page.tsx, and app/admin/actions/page.tsx. Migration 0086.';

GRANT SELECT ON crm.vw_enrolments_chaser_state TO authenticated, readonly_analytics;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- ALTER TABLE crm.enrolments ADD COLUMN last_chaser_at TIMESTAMPTZ;
-- UPDATE crm.enrolments e
--    SET last_chaser_at = sub.max_triggered_at
--   FROM (
--     SELECT submission_id, MAX(triggered_at) AS max_triggered_at
--       FROM crm.email_log
--      WHERE email_type IN ('chaser_funded', 'chaser_self')
--        AND status IN ('sent', 'delivered', 'opened', 'clicked')
--      GROUP BY submission_id
--   ) sub
--  WHERE sub.submission_id = e.submission_id;
-- DROP VIEW IF EXISTS crm.vw_enrolments_chaser_state;
-- -- Restore original fire_provider_chaser body — copy the function body
-- -- from migration 0046 which re-introduces the UPDATE crm.enrolments
-- -- SET last_chaser_at = now() statement before the audit.log_action call.
-- COMMIT;
