-- Migration 0024 — Provider edit helper (Session D)
-- Date: 2026-04-25
-- Author: Claude (platform Session D) with owner sign-off
-- Reason: Charlotte needs to edit provider contact details, CC emails,
--         auto-route toggle, pilot status, notes, and active flag from
--         the dashboard rather than opening Supabase directly. Same
--         SECURITY DEFINER pattern as crm.upsert_enrolment_outcome.
--
--         Scope intentionally narrow: only the fields that change
--         frequently. Pricing fields (per_enrolment_fee, percent_rate,
--         min_fee, max_fee, free_enrolments_remaining), billing_model,
--         sheet_id, sheet_webhook_url, agreement_signed_at, onboarded_at
--         all stay edit-only via Supabase for now (rare changes, would
--         clutter the form).
--
-- Related: platform/supabase/migrations/0020_audit_log_action_helper.sql,
--          platform/supabase/migrations/0022_enrolment_outcome_helper.sql.

-- UP

CREATE OR REPLACE FUNCTION crm.update_provider(
  p_provider_id        TEXT,
  p_contact_name       TEXT,
  p_contact_email      TEXT,
  p_contact_phone      TEXT,
  p_cc_emails          TEXT[],
  p_auto_route_enabled BOOLEAN,
  p_active             BOOLEAN,
  p_pilot_status       TEXT,
  p_notes              TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm, audit, admin, public
AS $$
DECLARE
  v_existing crm.providers%ROWTYPE;
  v_before   JSONB;
  v_after    JSONB;
BEGIN
  IF NOT admin.is_admin() THEN
    RAISE EXCEPTION 'Only admins can edit providers'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Validate pilot_status against the existing CHECK if any. Keep open-set
  -- here so we don't over-constrain the form ahead of the schema.
  IF p_pilot_status IS NULL OR length(trim(p_pilot_status)) = 0 THEN
    RAISE EXCEPTION 'pilot_status is required' USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_contact_email IS NULL OR length(trim(p_contact_email)) = 0 THEN
    RAISE EXCEPTION 'contact_email is required' USING ERRCODE = 'not_null_violation';
  END IF;

  -- Capture before state for audit
  SELECT *
    INTO v_existing
    FROM crm.providers
   WHERE provider_id = p_provider_id
   LIMIT 1;

  IF v_existing.provider_id IS NULL THEN
    RAISE EXCEPTION 'Provider % not found', p_provider_id USING ERRCODE = 'no_data_found';
  END IF;

  v_before := jsonb_build_object(
    'contact_name',       v_existing.contact_name,
    'contact_email',      v_existing.contact_email,
    'contact_phone',      v_existing.contact_phone,
    'cc_emails',          to_jsonb(v_existing.cc_emails),
    'auto_route_enabled', v_existing.auto_route_enabled,
    'active',             v_existing.active,
    'pilot_status',       v_existing.pilot_status,
    'notes',              v_existing.notes
  );

  UPDATE crm.providers
     SET contact_name       = p_contact_name,
         contact_email      = p_contact_email,
         contact_phone      = p_contact_phone,
         cc_emails          = COALESCE(p_cc_emails, '{}'::TEXT[]),
         auto_route_enabled = p_auto_route_enabled,
         active             = p_active,
         pilot_status       = p_pilot_status,
         notes              = p_notes,
         updated_at         = now()
   WHERE provider_id = p_provider_id;

  v_after := jsonb_build_object(
    'contact_name',       p_contact_name,
    'contact_email',      p_contact_email,
    'contact_phone',      p_contact_phone,
    'cc_emails',          to_jsonb(p_cc_emails),
    'auto_route_enabled', p_auto_route_enabled,
    'active',             p_active,
    'pilot_status',       p_pilot_status,
    'notes',              p_notes
  );

  PERFORM audit.log_action(
    p_action       := 'edit_provider',
    p_target_table := 'crm.providers',
    p_target_id    := p_provider_id,
    p_before       := v_before,
    p_after        := v_after,
    p_surface      := 'admin'
  );
END;
$$;

COMMENT ON FUNCTION crm.update_provider(TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN, BOOLEAN, TEXT, TEXT) IS
  'Edit a provider record from the admin dashboard. Atomic: validates, updates, writes audit row. Limited scope — pricing, billing_model, sheet config, agreement dates are NOT editable here (Supabase-only for now). Added migration 0024.';

REVOKE ALL ON FUNCTION crm.update_provider(TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN, BOOLEAN, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.update_provider(TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN, BOOLEAN, TEXT, TEXT) TO authenticated;

-- DOWN
-- REVOKE EXECUTE ON FUNCTION crm.update_provider(TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN, BOOLEAN, TEXT, TEXT) FROM authenticated;
-- DROP FUNCTION IF EXISTS crm.update_provider(TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN, BOOLEAN, TEXT, TEXT);
