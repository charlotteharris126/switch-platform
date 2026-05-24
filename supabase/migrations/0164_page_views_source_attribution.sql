-- Migration 0164 — page_views source attribution + bot flag + RPC v3
-- Date:   2026-05-24
-- Author: Claude (Sasha session) with owner sign-off
-- Reason:
--   /admin/experiments and any general analytics built on
--   ads_switchable.page_views can't be trusted while the table has no
--   provenance per load. Today every visit logs a row — Googlebot,
--   Bingbot, AhrefsBot, Slack/Twitter link previewers, security
--   scanners, owner QA traffic without sw_is_owner cookie, real paid
--   ad clicks, and organic visitors all land identically. Counselling
--   showed 4195 loads vs ~700 Meta link clicks; the gap is overwhelmingly
--   bot/crawler traffic plus pre-0162 refresh inflation. Without source
--   data we can't separate paid-real-human visits from the noise.
--
--   Right fix is per-row attribution at log time plus a server-detected
--   bot flag computed from user_agent. Dashboards filter is_bot=true out
--   of denominators by default; the forensic total_loads still includes
--   them. UTM params on the URL captured so paid-vs-organic-vs-direct
--   split is queryable without joining anything.
--
-- Related:
--   0068_page_views.sql                       (table created)
--   0162_page_views_session_id.sql           (session_id dedup + v2 RPC)
--   variant-router.ts                         (beacon caller, sw_qa cookie set)
--   log-page-view/index.ts                    (writer, computes is_bot)
--   /admin/experiments/page.tsx               (consumer, swaps to v3)
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: 6 nullable columns added (user_agent, referrer, utm_source,
--      utm_medium, utm_campaign, is_bot). Partial index on is_bot=false
--      for the common humans-only filter path. New RPC v3 that returns
--      humans-only unique_sessions + bot_sessions + total_loads per
--      experiment+variant. v2 stays live (unfiltered) for forensics.
--   2. Readers: /admin/experiments swaps to v3 same commit. Iris's MCP
--      queries hit the table directly via readonly_analytics — additive
--      columns are safe (existing SELECTs ignore them). v2 still
--      callable.
--   3. Writers: log-page-view EF updated same session to accept the new
--      payload fields + compute is_bot server-side from user_agent
--      regex. Belt-and-braces: variant-router.ts also passes a
--      client-computed is_bot hint, but the server is the source of truth.
--   4. Schema_version: page_views is internal (no external producer
--      contract). No bump required.
--   5. Data migration: none. Historic rows keep NULL on all new columns
--      and is_bot defaults to false (best assumption when we don't know;
--      total_loads still surfaces them).
--   6. Role / policy: none. RPC v3 mirrors v2's SECURITY DEFINER +
--      admin gate + EXECUTE grants.
--   7. Rollback: DROP RPC v3, DROP INDEX, DROP COLUMN x6 in DOWN.
--      Admin page must revert to v2. Safe at any point.
--   8. Sign-off: owner 2026-05-24 ("dont we need to stop bots?...
--      whatever you think we need to do").

BEGIN;

-- 1. Columns -----------------------------------------------------------------

ALTER TABLE ads_switchable.page_views
  ADD COLUMN user_agent   TEXT,
  ADD COLUMN referrer     TEXT,
  ADD COLUMN utm_source   TEXT,
  ADD COLUMN utm_medium   TEXT,
  ADD COLUMN utm_campaign TEXT,
  ADD COLUMN is_bot       BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN ads_switchable.page_views.user_agent IS
  'Raw User-Agent header from the inbound request as captured by the '
  'variant-router Netlify Edge Function. Used to compute is_bot at log '
  'time and to debug suspicious traffic patterns. NULL on pre-0164 rows.';

COMMENT ON COLUMN ads_switchable.page_views.referrer IS
  'Referer header from the inbound request (note: HTTP misspelling preserved '
  'in the wire format; column uses correct double-r). NULL when the visitor '
  'came direct (typed URL, bookmark, app deep-link with no referrer) or '
  'when the referring page strips the header via Referrer-Policy. NULL on '
  'pre-0164 rows.';

COMMENT ON COLUMN ads_switchable.page_views.utm_source IS
  'utm_source query param at log time. Same provenance as leads.submissions.utm_source. '
  'NULL on pre-0164 rows and on visits without UTM tagging.';

COMMENT ON COLUMN ads_switchable.page_views.utm_medium IS
  'utm_medium query param at log time. NULL on pre-0164 rows and untagged visits.';

COMMENT ON COLUMN ads_switchable.page_views.utm_campaign IS
  'utm_campaign query param at log time. NULL on pre-0164 rows and untagged visits.';

COMMENT ON COLUMN ads_switchable.page_views.is_bot IS
  'Server-computed bot/crawler/link-previewer flag based on user_agent regex '
  'in log-page-view Edge Function. Includes search-engine crawlers (Googlebot, '
  'Bingbot, etc.), SEO bots (AhrefsBot, Semrush, Moz), social link-preview '
  'fetchers (facebookexternalhit, Twitterbot, LinkedInBot, Slackbot, '
  'WhatsApp), uptime monitors, and generic curl/wget/python-requests. '
  'Default false (assume human if no signal). Pre-0164 rows are all false '
  'because we had no user_agent at the time — that historic data is '
  'unreliable and should be read as a forensic upper bound only.';

-- 2. Indexes -----------------------------------------------------------------
-- Partial index on humans-only is the hot path: every /admin/experiments
-- read filters is_bot=false. Postgres can use a partial index for both
-- equality and IS DISTINCT FROM TRUE predicates that resolve to the
-- false partition.

CREATE INDEX ads_switchable_page_views_humans_idx
  ON ads_switchable.page_views (experiment_id, page_slug, variant, session_id)
  WHERE is_bot = false;

-- 3. RPC v3 ------------------------------------------------------------------
-- Returns humans-only unique_sessions (the trust-anchor metric) alongside
-- bot_sessions and total_loads for transparency. /admin/experiments uses
-- unique_sessions as the rate denominator and surfaces bot_sessions in a
-- tooltip so the user can sanity-check the filtering.

CREATE OR REPLACE FUNCTION ads_switchable.get_experiment_view_counts_v3()
RETURNS TABLE(
  experiment_id        TEXT,
  variant              TEXT,
  total_loads          BIGINT,
  unique_sessions      BIGINT,  -- humans only (is_bot=false)
  bot_sessions         BIGINT,  -- bots only (is_bot=true)
  null_session_loads   BIGINT   -- humans without session_id (pre-0162 historicals or no cookie)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ads_switchable, admin, public
AS $$
BEGIN
  IF NOT admin.is_admin() THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    pv.experiment_id,
    pv.variant,
    COUNT(*)::BIGINT
      AS total_loads,
    COUNT(DISTINCT pv.session_id)
      FILTER (WHERE pv.session_id IS NOT NULL AND pv.is_bot = false)::BIGINT
      AS unique_sessions,
    COUNT(DISTINCT pv.session_id)
      FILTER (WHERE pv.session_id IS NOT NULL AND pv.is_bot = true)::BIGINT
      AS bot_sessions,
    COUNT(*)
      FILTER (WHERE pv.session_id IS NULL AND pv.is_bot = false)::BIGINT
      AS null_session_loads
  FROM ads_switchable.page_views pv
  GROUP BY pv.experiment_id, pv.variant;
END;
$$;

COMMENT ON FUNCTION ads_switchable.get_experiment_view_counts_v3() IS
  'Aggregated A/B page-view stats with bot filtering, per migration 0164. '
  'Returns one row per (experiment_id, variant) with: total_loads (every '
  'row, including bots and null-session rows), unique_sessions (humans '
  'only, deduped by sw_session UUID, the right denominator for '
  'conversion-rate display), bot_sessions (crawler/preview/scanner '
  'sessions filtered out), null_session_loads (real loads with no '
  'session cookie — pre-0162 historicals or visitors who blocked the '
  'cookie). SECURITY DEFINER + admin.is_admin() gate. v2 kept live for '
  'unfiltered queries.';

GRANT EXECUTE ON FUNCTION ads_switchable.get_experiment_view_counts_v3() TO authenticated;
GRANT EXECUTE ON FUNCTION ads_switchable.get_experiment_view_counts_v3() TO readonly_analytics;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP FUNCTION IF EXISTS ads_switchable.get_experiment_view_counts_v3();
-- DROP INDEX  IF EXISTS ads_switchable.ads_switchable_page_views_humans_idx;
-- ALTER TABLE ads_switchable.page_views
--   DROP COLUMN IF EXISTS user_agent,
--   DROP COLUMN IF EXISTS referrer,
--   DROP COLUMN IF EXISTS utm_source,
--   DROP COLUMN IF EXISTS utm_medium,
--   DROP COLUMN IF EXISTS utm_campaign,
--   DROP COLUMN IF EXISTS is_bot;
-- COMMIT;
