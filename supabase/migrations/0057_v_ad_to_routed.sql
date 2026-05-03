-- Migration 0057 — Iris stage 1b: ads_switchable.v_ad_to_routed view
-- Date: 2026-05-03
-- Author: Claude (Sasha session) with owner review
-- Reason: Per-ad join from Meta spend → DB-recorded leads → routed leads.
--   Powers the "leads → qualified → routed" drill-down column in the
--   /admin/ads performance table (stage 4) and the cost-per-routed-lead
--   metric. Also a source view for stage 2's `iris-daily-flags` Edge
--   Function (P2.2 CPL anomaly check uses this).
--
--   Join key: leads.submissions.utm_content holds Meta's {{ad.id}} for paid
--   submissions (per `platform/docs/data-architecture.md` UTM template).
--   Date join keeps spend-vs-lead daily granularity intact.
--
--   Filters paid leads only (utm_medium = 'paid') so organic / referral
--   submissions don't pollute the per-ad lead counts. parent_submission_id
--   IS NULL filter applied in the qualified/routed counts to match the True
--   CPL convention from migration 0050's downstream consumers (children
--   carry parent UTMs but don't represent novel paid conversions; see
--   feedback memory `feedback_paid_lead_count_filter.md`).
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new view `ads_switchable.v_ad_to_routed`. No table changes.
--   2. Readers affected: none yet — view is queryable but no consumer wired
--      until stage 2 Edge Function and stage 4 dashboard ship. Granted
--      SELECT to `authenticated` (dashboard) and `iris_writer` (stage 2).
--   3. Writers: n/a — view is read-only.
--   4. Schema version: not affected (no payload contract change).
--   5. Data migration: none.
--   6. New role/policy: no new roles. Grants only.
--   7. Rollback: DROP VIEW in DOWN.
--   8. Sign-off: owner (this session).
--
-- Related:
--   ClickUp 869d4ubxc (Iris stage 1b)
--   switchable/ads/docs/ads-dashboard-scope.md (stage 1b spec)
--   feedback memory: feedback_paid_lead_count_filter.md
-- =============================================================================

BEGIN;

CREATE OR REPLACE VIEW ads_switchable.v_ad_to_routed AS
SELECT
  md.ad_id,
  md.ad_name,
  md.campaign_id,
  md.campaign_name,
  md.date,
  md.spend,
  md.leads AS leads_meta,
  COUNT(*) FILTER (WHERE s.parent_submission_id IS NULL) AS leads_db_total,
  COUNT(*) FILTER (
    WHERE s.is_dq = false AND s.parent_submission_id IS NULL
  ) AS leads_qualified,
  COUNT(*) FILTER (
    WHERE s.is_dq = false
      AND s.parent_submission_id IS NULL
      AND s.primary_routed_to IS NOT NULL
  ) AS leads_routed,
  CASE
    WHEN COUNT(*) FILTER (
      WHERE s.is_dq = false
        AND s.parent_submission_id IS NULL
        AND s.primary_routed_to IS NOT NULL
    ) > 0
    THEN ROUND(
      md.spend / COUNT(*) FILTER (
        WHERE s.is_dq = false
          AND s.parent_submission_id IS NULL
          AND s.primary_routed_to IS NOT NULL
      ),
      2
    )
  END AS cost_per_routed_lead
FROM ads_switchable.meta_daily md
LEFT JOIN leads.submissions s
  ON s.utm_content = md.ad_id
  AND s.submitted_at::date = md.date
  AND s.utm_medium = 'paid'
GROUP BY
  md.ad_id, md.ad_name, md.campaign_id, md.campaign_name,
  md.date, md.spend, md.leads;

COMMENT ON VIEW ads_switchable.v_ad_to_routed IS
  'Per-ad daily join: Meta spend ↔ DB-recorded leads ↔ routed leads. Filters s.utm_medium = ''paid'' on the join so organic/referral submissions are excluded from per-ad counts. parent_submission_id IS NULL filter excludes children that carry parent UTMs but don''t represent novel paid conversions (per feedback_paid_lead_count_filter.md). Powers /admin/ads drill-down and feeds iris-daily-flags P2.2 CPL anomaly check. Migration 0057 (stage 1b).';

-- Grants
GRANT SELECT ON ads_switchable.v_ad_to_routed TO authenticated;
GRANT SELECT ON ads_switchable.v_ad_to_routed TO iris_writer;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- REVOKE SELECT ON ads_switchable.v_ad_to_routed FROM iris_writer;
-- REVOKE SELECT ON ads_switchable.v_ad_to_routed FROM authenticated;
-- DROP VIEW ads_switchable.v_ad_to_routed;
-- COMMIT;
