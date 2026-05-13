-- Data-ops 029 — RLS role/grant audit (run-on-demand)
-- Date:   2026-05-13
-- Owner:  Charlotte / Sasha
-- Reason:
--   Catches the class of bug that broke Emma Newton's auto-DQ today: a
--   table that has either (a) an RLS policy targeting a role but no
--   matching table-level GRANT, or (b) a table-level GRANT for a role
--   but no permissive RLS policy for that role. Both manifest as a
--   silent 42501 ("new row violates row-level security policy") at
--   runtime — visible only via dead_letter logs.
--
--   This is a SELECT-only audit. Run it manually, or wire it into
--   Sasha's Monday weekly health report by copying the queries into
--   her playbook.
--
-- How to read the output:
--   Query 1: roles that have INSERT/UPDATE/DELETE GRANTs on a table
--            but no permissive RLS policy targeting them for that
--            command. They WILL fail with 42501 when they try.
--   Query 2: roles named in RLS policies that don't have the matching
--            table-level GRANT. Postgres evaluates GRANT before RLS,
--            so these also fail at runtime.
--   Query 3: comparison of crm.* tables that have functions_writer
--            access via either mechanism — useful for spotting tables
--            that are missing the n8n_write_* policy pattern.

-- ─── Query 1: roles with GRANT but no matching RLS policy ──────────────
SELECT
  g.table_schema,
  g.table_name,
  g.grantee AS role_name,
  g.privilege_type AS granted,
  CASE
    WHEN p.policyname IS NULL THEN 'NO MATCHING POLICY — WILL FAIL'
    ELSE p.policyname
  END AS rls_policy_status
FROM information_schema.role_table_grants g
LEFT JOIN pg_policies p
       ON p.schemaname = g.table_schema
      AND p.tablename = g.table_name
      AND g.grantee::name = ANY (p.roles)
      AND (
        p.cmd = 'ALL'
        OR p.cmd = g.privilege_type
      )
WHERE g.table_schema IN ('crm', 'leads', 'audit', 'public')
  AND g.privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  AND g.grantee NOT IN ('postgres', 'service_role', 'PUBLIC', 'supabase_admin', 'authenticator')
  AND p.policyname IS NULL
ORDER BY g.table_schema, g.table_name, g.grantee, g.privilege_type;

-- ─── Query 2: roles named in RLS policies but missing GRANT ────────────
WITH policy_roles AS (
  SELECT
    p.schemaname,
    p.tablename,
    p.policyname,
    p.cmd,
    unnest(p.roles) AS role_name
  FROM pg_policies p
  WHERE p.schemaname IN ('crm', 'leads', 'audit', 'public')
)
SELECT
  pr.schemaname,
  pr.tablename,
  pr.role_name,
  pr.policyname,
  pr.cmd AS policy_cmd,
  CASE
    WHEN pr.role_name IN ('public', 'PUBLIC', 'service_role', 'authenticated', 'anon', 'authenticator', 'postgres', 'supabase_admin') THEN 'system role (skipped)'
    WHEN has_table_privilege(pr.role_name, format('%I.%I', pr.schemaname, pr.tablename)::regclass, 'INSERT') THEN 'GRANT ok'
    ELSE 'NO GRANT — POLICY WILL FAIL AT RUNTIME'
  END AS grant_status
FROM policy_roles pr
WHERE pr.role_name NOT IN ('public', 'PUBLIC', 'service_role', 'authenticated', 'anon', 'authenticator', 'postgres', 'supabase_admin')
ORDER BY grant_status DESC, pr.schemaname, pr.tablename;

-- ─── Query 3: functions_writer coverage by table in crm.* ──────────────
WITH crm_tables AS (
  SELECT tablename
    FROM pg_tables
   WHERE schemaname = 'crm'
)
SELECT
  t.tablename,
  has_table_privilege('functions_writer', format('crm.%I', t.tablename)::regclass, 'INSERT') AS can_insert,
  has_table_privilege('functions_writer', format('crm.%I', t.tablename)::regclass, 'UPDATE') AS can_update,
  EXISTS (
    SELECT 1 FROM pg_policies p
     WHERE p.schemaname = 'crm'
       AND p.tablename = t.tablename
       AND 'functions_writer' = ANY (p.roles)
  ) AS has_rls_policy,
  CASE
    WHEN has_table_privilege('functions_writer', format('crm.%I', t.tablename)::regclass, 'INSERT')
     AND NOT EXISTS (
       SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'crm'
          AND p.tablename = t.tablename
          AND 'functions_writer' = ANY (p.roles)
     )
    THEN 'WRITE GRANT BUT NO POLICY — RUNTIME 42501 RISK'
    ELSE 'ok'
  END AS verdict
FROM crm_tables t
ORDER BY verdict DESC, t.tablename;
