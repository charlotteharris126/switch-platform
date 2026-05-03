-- Migration 0065 — Iris stage 5: ads_switchable.v_ad_to_enrolment view
-- Date: 2026-05-03
-- Author: Claude (Sasha session) with owner review
-- Reason: Closed-loop attribution. Extends v_ad_to_routed (migration 0057)
--   with per-ad enrolment counts, revenue, and cost-per-enrolment. The
--   ultimate "this ad → these leads → these enrolments → this revenue" view.
--   Powers the future Cost-per-enrolment tile on /admin/ads (currently
--   placeholder) and is the spine for stage P3.1's closed-loop CPA flag
--   automation when Phase 4 enrolments accumulate.
--
--   View can ship now even though crm.enrolments is empty at pilot scale.
--   It returns zero enrolments/revenue per ad until real data lands; no
--   behaviour change required when enrolments start populating.
--
--   Schema note: scope doc speculated `invoice_amount_pence` but the actual
--   column is `crm.enrolments.billed_amount` (NUMERIC, in £). Adjusted.
--   Only `enrolled` and `presumed_enrolled` statuses count toward revenue;
--   lost / cannot_reach / open are excluded (no revenue on those).
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: new view `ads_switchable.v_ad_to_enrolment`. No table changes.
--   2. Readers affected: none yet. Future /admin/ads cost-per-enrolment tile
--      reads from here; future P3.1 Iris automation will too.
--   3. Writers: n/a — view is read-only.
--   4. Schema version: not affected.
--   5. Data migration: none.
--   6. New role/policy: no. Grants only.
--   7. Rollback: DROP VIEW in DOWN.
--   8. Sign-off: owner (this session).
--
-- Related:
--   ClickUp 869d4vu3x (the /admin/ads ticket, technically stage 4 but stage 5
--     is the natural extension for the cost-per-enrolment tile and drill-down
--     revenue numbers — same review surface).
--   switchable/ads/docs/ads-dashboard-scope.md (stage 5 spec)
--   platform/supabase/migrations/0057_v_ad_to_routed.sql
-- =============================================================================

BEGIN;

CREATE OR REPLACE VIEW ads_switchable.v_ad_to_enrolment AS
SELECT
  vatr.ad_id,
  vatr.ad_name,
  vatr.campaign_id,
  vatr.campaign_name,
  vatr.date,
  vatr.spend,
  vatr.leads_meta,
  vatr.leads_db_total,
  vatr.leads_qualified,
  vatr.leads_routed,
  vatr.cost_per_routed_lead,
  COUNT(e.id) FILTER (WHERE e.status IN ('enrolled', 'presumed_enrolled')) AS leads_enrolled,
  COALESCE(SUM(e.billed_amount) FILTER (WHERE e.status IN ('enrolled', 'presumed_enrolled')), 0)::NUMERIC AS revenue,
  CASE
    WHEN COUNT(e.id) FILTER (WHERE e.status IN ('enrolled', 'presumed_enrolled')) > 0
    THEN ROUND(
      vatr.spend / COUNT(e.id) FILTER (WHERE e.status IN ('enrolled', 'presumed_enrolled')),
      2
    )
  END AS cost_per_enrolment
FROM ads_switchable.v_ad_to_routed vatr
LEFT JOIN leads.submissions s
  ON s.utm_content = vatr.ad_id
  AND s.submitted_at::date = vatr.date
  AND s.utm_medium = 'paid'
  AND s.parent_submission_id IS NULL
LEFT JOIN crm.enrolments e
  ON e.submission_id = s.id
GROUP BY
  vatr.ad_id, vatr.ad_name, vatr.campaign_id, vatr.campaign_name,
  vatr.date, vatr.spend, vatr.leads_meta, vatr.leads_db_total,
  vatr.leads_qualified, vatr.leads_routed, vatr.cost_per_routed_lead;

COMMENT ON VIEW ads_switchable.v_ad_to_enrolment IS
  'Closed-loop attribution: per-ad daily spend ↔ qualified leads ↔ routed leads ↔ enrolments ↔ revenue. Only enrolled + presumed_enrolled statuses contribute to leads_enrolled and revenue (lost / cannot_reach / open excluded). Returns zero enrolments per ad until crm.enrolments populates from real revenue (Phase 4-ish). Powers future /admin/ads cost-per-enrolment tile and Iris P3.1 closed-loop CPA flag. Migration 0065 (stage 5).';

GRANT SELECT ON ads_switchable.v_ad_to_enrolment TO authenticated;
GRANT SELECT ON ads_switchable.v_ad_to_enrolment TO iris_writer;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- REVOKE SELECT ON ads_switchable.v_ad_to_enrolment FROM iris_writer;
-- REVOKE SELECT ON ads_switchable.v_ad_to_enrolment FROM authenticated;
-- DROP VIEW ads_switchable.v_ad_to_enrolment;
-- COMMIT;
