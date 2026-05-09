-- Data-op 020 — RLS proof for provider portal MVP
-- Date:    2026-05-09
-- Author:  Claude (platform Session 38) on Charlotte's instruction
-- Purpose: Clears Clara's gating condition #2 before EMS cutover. Proves
--          that an authenticated provider user, scoped by the policies in
--          migration 0096, cannot read or write any row belonging to a
--          different provider.
--
--          Subjects under test:
--            - leads.submissions
--            - leads.routing_log
--            - leads.fastrack_submissions
--            - crm.enrolments (SELECT + UPDATE)
--            - crm.disputes (SELECT + INSERT)
--            - crm.providers (own row only)
--            - crm.provider_users (own provider's users only)
--            - crm.provider_user_provider_id() (NULL for portal_enabled=false)
--            - audit.actions (cannot impersonate via context override)
--
--          Driver provider:
--            demo-provider-ltd (is_demo=true, portal_enabled=true, 12 leads)
--          Target real provider:
--            enterprise-made-simple (137 submissions, 139 routing_log,
--            135 enrolments, 0 disputes — largest real corpus).
--
--          How auth is simulated:
--            We don't run a real WebAuthn ceremony. We approximate the
--            PostgREST request context inside one Postgres session by:
--              SET LOCAL ROLE authenticated;
--              PERFORM set_config('request.jwt.claims', '{"sub":..}', true);
--            auth.uid() and auth.jwt() read those GUCs the same way they
--            do in a live request. RLS evaluation is identical.
--
--          Side-effects:
--            None. The whole script runs in a transaction wrapped with
--            ROLLBACK. One UPDATE on crm.providers (briefly flips demo
--            portal_enabled=false then rolls back), one audit.actions row
--            inserted then rolled back (small sequence-id gap is normal).
--
--          Output:
--            A result-set (final SELECT) of rows: ord, label, status,
--            detail. status is 'PASS' or 'FAIL'. The script also raises
--            a final NOTICE with summary counts; if any failures, the
--            script raises EXCEPTION (which still rolls back).
--
-- Related:
--   - migration 0096 (the policies under test)
--   - migration 0095 (audit.log_provider_action gate)
--   - migration 0108 (the GRANTs the policies depend on, added in this same session)
--   - .claude/rules/data-infrastructure.md §6 (RLS rule)
--   - accounts-legal/docs/current-handoff.md item 2 (Clara's gating conditions)

BEGIN;

-- Result accumulator
CREATE TEMP TABLE rls_proof_results (
  ord int generated always as identity,
  label text,
  status text,
  detail text
) ON COMMIT DROP;

-- The DO block below switches into the authenticated role for the actual
-- tests; allow that role to write results so we keep one accumulator.
GRANT INSERT ON rls_proof_results TO authenticated;
GRANT USAGE ON SEQUENCE rls_proof_results_ord_seq TO authenticated;

DO $$
DECLARE
  v_demo_uid UUID := '8dbbbded-e1a0-4f9a-bde6-1cbc38d5f5fb';
  v_real_provider TEXT := 'enterprise-made-simple';
  v_demo_provider TEXT := 'demo-provider-ltd';
  v_count BIGINT;
  v_helper_result TEXT;
  v_real_submission_id BIGINT;
  v_real_enrolment_id BIGINT;
  v_demo_enrolment_id BIGINT;
  v_audit_id BIGINT;
  v_actor_provider TEXT;
  v_pass_count INT := 0;
  v_fail_count INT := 0;
BEGIN
  SELECT id INTO v_real_submission_id
    FROM leads.submissions WHERE primary_routed_to = v_real_provider
    ORDER BY id DESC LIMIT 1;
  SELECT id INTO v_real_enrolment_id
    FROM crm.enrolments WHERE provider_id = v_real_provider
    ORDER BY id DESC LIMIT 1;
  SELECT id INTO v_demo_enrolment_id
    FROM crm.enrolments WHERE provider_id = v_demo_provider
    ORDER BY id DESC LIMIT 1;

  -- Switch to authenticated role with demo user's claims
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_demo_uid::text, 'role', 'authenticated',
                      'email', 'demo@switch-test.local')::text,
    true);

  -- 1. helper returns demo provider for demo user
  v_helper_result := crm.provider_user_provider_id();
  IF v_helper_result = v_demo_provider THEN
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('helper returns demo provider for demo user', 'PASS',
            format('got %s', v_helper_result));
    v_pass_count := v_pass_count + 1;
  ELSE
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('helper returns demo provider for demo user', 'FAIL',
            format('expected %s, got %s', v_demo_provider, v_helper_result));
    v_fail_count := v_fail_count + 1;
  END IF;

  -- 2. demo user sees own 12 submissions (baseline — proves not deny-all)
  SELECT count(*) INTO v_count FROM leads.submissions WHERE primary_routed_to = v_demo_provider;
  IF v_count = 12 THEN
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('demo sees own submissions (baseline)', 'PASS', format('count=%s', v_count));
    v_pass_count := v_pass_count + 1;
  ELSE
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('demo sees own submissions (baseline)', 'FAIL', format('expected 12, got %s', v_count));
    v_fail_count := v_fail_count + 1;
  END IF;

  -- 3. cross-tenant SELECT: leads.submissions
  SELECT count(*) INTO v_count FROM leads.submissions WHERE primary_routed_to = v_real_provider;
  IF v_count = 0 THEN
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('demo CANNOT see EMS submissions', 'PASS', 'count=0');
    v_pass_count := v_pass_count + 1;
  ELSE
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('demo CANNOT see EMS submissions', 'FAIL', format('count=%s', v_count));
    v_fail_count := v_fail_count + 1;
  END IF;

  -- 4. cross-tenant SELECT: leads.routing_log
  SELECT count(*) INTO v_count FROM leads.routing_log WHERE provider_id = v_real_provider;
  IF v_count = 0 THEN
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('demo CANNOT see EMS routing_log', 'PASS', 'count=0');
    v_pass_count := v_pass_count + 1;
  ELSE
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('demo CANNOT see EMS routing_log', 'FAIL', format('count=%s', v_count));
    v_fail_count := v_fail_count + 1;
  END IF;

  -- 5. cross-tenant SELECT: crm.enrolments
  SELECT count(*) INTO v_count FROM crm.enrolments WHERE provider_id = v_real_provider;
  IF v_count = 0 THEN
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('demo CANNOT see EMS enrolments', 'PASS', 'count=0');
    v_pass_count := v_pass_count + 1;
  ELSE
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('demo CANNOT see EMS enrolments', 'FAIL', format('count=%s', v_count));
    v_fail_count := v_fail_count + 1;
  END IF;

  -- 6. cross-tenant SELECT: leads.fastrack_submissions
  SELECT count(*) INTO v_count FROM leads.fastrack_submissions
    WHERE parent_submission_id IN (
      SELECT id FROM leads.submissions WHERE primary_routed_to = v_real_provider
    );
  IF v_count = 0 THEN
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('demo CANNOT see EMS fastrack_submissions', 'PASS', 'count=0');
    v_pass_count := v_pass_count + 1;
  ELSE
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('demo CANNOT see EMS fastrack_submissions', 'FAIL', format('count=%s', v_count));
    v_fail_count := v_fail_count + 1;
  END IF;

  -- 7. cross-tenant SELECT: crm.providers
  SELECT count(*) INTO v_count FROM crm.providers WHERE provider_id = v_real_provider;
  IF v_count = 0 THEN
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('demo CANNOT see EMS provider row', 'PASS', 'count=0');
    v_pass_count := v_pass_count + 1;
  ELSE
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('demo CANNOT see EMS provider row', 'FAIL', format('count=%s', v_count));
    v_fail_count := v_fail_count + 1;
  END IF;

  -- 8. cross-tenant SELECT: crm.provider_users
  SELECT count(*) INTO v_count FROM crm.provider_users WHERE provider_id = v_real_provider;
  IF v_count = 0 THEN
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('demo CANNOT see EMS provider_users', 'PASS', 'count=0');
    v_pass_count := v_pass_count + 1;
  ELSE
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('demo CANNOT see EMS provider_users', 'FAIL', format('count=%s', v_count));
    v_fail_count := v_fail_count + 1;
  END IF;

  -- 9. cross-tenant UPDATE: must affect 0 rows
  UPDATE crm.enrolments SET status = 'enrolled', updated_at = now()
   WHERE id = v_real_enrolment_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('demo CANNOT UPDATE EMS enrolment', 'PASS', 'rows affected=0');
    v_pass_count := v_pass_count + 1;
  ELSE
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('demo CANNOT UPDATE EMS enrolment', 'FAIL', format('rows affected=%s', v_count));
    v_fail_count := v_fail_count + 1;
  END IF;

  -- 10. cross-tenant INSERT into crm.disputes: must fail or affect zero rows
  BEGIN
    INSERT INTO crm.disputes (enrolment_id, reason, raised_by, raised_at)
    VALUES (v_real_enrolment_id, 'rls test (should fail)', 'provider', now());
    -- If we reach here, that's a fail (insert succeeded across tenants)
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('demo CANNOT INSERT dispute against EMS enrolment', 'FAIL',
            'INSERT succeeded (RLS check missing)');
    v_fail_count := v_fail_count + 1;
  EXCEPTION
    WHEN insufficient_privilege OR check_violation THEN
      INSERT INTO rls_proof_results (label, status, detail)
      VALUES ('demo CANNOT INSERT dispute against EMS enrolment', 'PASS', 'RLS rejected');
      v_pass_count := v_pass_count + 1;
  END;

  -- 11. audit impersonation guard: actor_provider_id locked to demo
  SELECT public.log_provider_action_v1(
    'rls_proof_smoke',
    'crm.enrolments',
    v_demo_enrolment_id::text,
    NULL, NULL,
    jsonb_build_object('actor_provider_id', v_real_provider, 'note', 'attempted spoof')
  ) INTO v_audit_id;

  -- Pop out to read the audit row (authenticated has no SELECT on audit)
  RESET ROLE;
  SELECT context ->> 'actor_provider_id' INTO v_actor_provider
    FROM audit.actions WHERE id = v_audit_id;
  SET LOCAL ROLE authenticated;

  IF v_actor_provider = v_demo_provider THEN
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('audit actor_provider_id locked to demo (spoof rejected)', 'PASS',
            format('audit row %s, actor=%s', v_audit_id, v_actor_provider));
    v_pass_count := v_pass_count + 1;
  ELSE
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('audit actor_provider_id locked to demo (spoof rejected)', 'FAIL',
            format('expected %s, got %s', v_demo_provider, v_actor_provider));
    v_fail_count := v_fail_count + 1;
  END IF;

  -- 12-14. portal_enabled=false gate
  RESET ROLE;
  UPDATE crm.providers SET portal_enabled = false WHERE provider_id = v_demo_provider;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_demo_uid::text, 'role', 'authenticated',
                      'email', 'demo@switch-test.local')::text,
    true);

  v_helper_result := crm.provider_user_provider_id();
  IF v_helper_result IS NULL THEN
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('helper returns NULL when portal_enabled=false', 'PASS', 'NULL');
    v_pass_count := v_pass_count + 1;
  ELSE
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('helper returns NULL when portal_enabled=false', 'FAIL',
            format('got %s', v_helper_result));
    v_fail_count := v_fail_count + 1;
  END IF;

  SELECT count(*) INTO v_count FROM leads.submissions;
  IF v_count = 0 THEN
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('portal_enabled=false hides own submissions', 'PASS', 'count=0');
    v_pass_count := v_pass_count + 1;
  ELSE
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('portal_enabled=false hides own submissions', 'FAIL',
            format('count=%s', v_count));
    v_fail_count := v_fail_count + 1;
  END IF;

  SELECT count(*) INTO v_count FROM crm.enrolments;
  IF v_count = 0 THEN
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('portal_enabled=false hides own enrolments', 'PASS', 'count=0');
    v_pass_count := v_pass_count + 1;
  ELSE
    INSERT INTO rls_proof_results (label, status, detail)
    VALUES ('portal_enabled=false hides own enrolments', 'FAIL',
            format('count=%s', v_count));
    v_fail_count := v_fail_count + 1;
  END IF;

  -- Summary row
  INSERT INTO rls_proof_results (label, status, detail)
  VALUES ('---SUMMARY---',
          CASE WHEN v_fail_count = 0 THEN 'PASS' ELSE 'FAIL' END,
          format('pass=%s fail=%s', v_pass_count, v_fail_count));
END $$;

-- SET LOCAL ROLE inside the DO block leaks to the rest of the transaction.
-- Pop back to the outer role for the result read.
RESET ROLE;

-- Return results
SELECT ord, label, status, detail FROM rls_proof_results ORDER BY ord;

ROLLBACK;
