-- Migration 0113 — count_client_nonce_pending() helper for /admin/data-ops
-- Date: 2026-05-11
-- Author: Claude (Charlotte's platform session, after 025 backfill shipped)
-- Reason: /admin/data-ops auto-hides backfill panels once their fix is
--         complete. The 025 (client_nonce) panel's pending state is
--         server-checkable via a simple count of the audience. This RPC
--         exposes the count to the admin Server Component without
--         duplicating the audience filter in TS.
-- Related: supabase/functions/backfill-client-nonce/index.ts (same
--         audience filter, source of truth lives there; the function
--         and this view drift if either changes — keep in sync).

-- UP
CREATE OR REPLACE FUNCTION public.count_client_nonce_pending()
RETURNS BIGINT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT count(*)::BIGINT
  FROM leads.submissions s
  WHERE s.funding_category IN ('gov', 'loan')
    AND s.client_nonce IS NULL
    AND s.is_dq IS NOT TRUE
    AND NOT EXISTS (
      SELECT 1 FROM crm.enrolments e
      WHERE e.submission_id = s.id
        AND e.status IN ('enrolled', 'presumed_enrolled')
    )
$$;

COMMENT ON FUNCTION public.count_client_nonce_pending IS
  'Pending count for the 025 client_nonce backfill (used by /admin/data-ops to auto-hide the panel when 0). Mirrors the audience filter in backfill-client-nonce/index.ts.';

-- The Server Component reads via the admin (service_role) client, so
-- exposing to authenticated/anon isn't required. Keep tight.
REVOKE EXECUTE ON FUNCTION public.count_client_nonce_pending() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_client_nonce_pending() TO service_role;

-- DOWN
-- DROP FUNCTION public.count_client_nonce_pending();
