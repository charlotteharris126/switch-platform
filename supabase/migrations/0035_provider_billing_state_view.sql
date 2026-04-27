-- Migration 0035 — Derived provider billing state view
-- Date: 2026-04-27
-- Author: Claude (platform Session 13) with owner sign-off
-- Reason: `crm.providers.free_enrolments_remaining` is a static integer set
--         to 3 at provider creation. Nothing decrements it as enrolments
--         confirm — there's no trigger, no scheduled job, no business logic
--         that maintains it. As of 2026-04-27 every provider in the table
--         shows 3-free-remaining despite real enrolment counts: EMS 4 enrolled
--         + 3 presumed (already past free), WYK 3 enrolled (exactly 3-free
--         used).
--
--         Derive billing state from the canonical source — the actual rows
--         in `crm.enrolments` — instead of trying to keep a counter in sync.
--         Computed-from-data has no drift class.
--
--         Pilot rule (per `.claude/rules/business.md`): first 3 enrolments
--         per provider are free, remainder are billable. Counts include
--         BOTH `enrolled` and `presumed_enrolled` because presumed flips to
--         billable after the 7-day dispute window unless disputed.
--
--         This view replaces direct reads of `free_enrolments_remaining`
--         on the dashboard. The static column stays in place for now (could
--         deprecate later) — no migrations should write to it any more.
--
-- Related: `.claude/rules/business.md` § Business model (pilot pricing),
--          `platform/supabase/migrations/0001_init_pilot_schemas.sql`
--          (where `free_enrolments_remaining` was originally defined),
--          `platform/supabase/migrations/0028_enrolment_status_taxonomy_refactor.sql`
--          (current status enum: open / enrolled / presumed_enrolled /
--          cannot_reach / lost).

-- UP

CREATE OR REPLACE VIEW crm.vw_provider_billing_state
  WITH (security_invoker = true) AS
WITH counts AS (
  SELECT
    p.provider_id,
    p.company_name,
    p.active,
    p.pilot_status,
    p.pricing_model,
    COUNT(e.id)                                                      AS total_enrolment_rows,
    COUNT(*) FILTER (WHERE e.status = 'enrolled')                    AS confirmed_enrolled,
    COUNT(*) FILTER (WHERE e.status = 'presumed_enrolled')           AS presumed_enrolled,
    COUNT(*) FILTER (WHERE e.status = 'cannot_reach')                AS cannot_reach,
    COUNT(*) FILTER (WHERE e.status = 'lost')                        AS lost,
    COUNT(*) FILTER (WHERE e.status = 'open')                        AS still_open,
    COUNT(*) FILTER (WHERE e.disputed_at IS NOT NULL)                AS disputed,
    -- Pilot rule: presumed_enrolled counts toward free + billing because
    -- it auto-flips to billable after the 7-day dispute window.
    COUNT(*) FILTER (
      WHERE e.status IN ('enrolled', 'presumed_enrolled')
    ) AS billable_or_pending_count
  FROM crm.providers p
    LEFT JOIN crm.enrolments e ON e.provider_id = p.provider_id
   GROUP BY p.provider_id, p.company_name, p.active, p.pilot_status, p.pricing_model
),
routing AS (
  SELECT provider_id, COUNT(*) AS total_routed
    FROM leads.routing_log
   GROUP BY provider_id
)
SELECT
  c.provider_id,
  c.company_name,
  c.active,
  c.pilot_status,
  c.pricing_model,
  COALESCE(r.total_routed, 0)                                         AS total_routed,
  c.confirmed_enrolled,
  c.presumed_enrolled,
  c.cannot_reach,
  c.lost,
  c.still_open,
  c.disputed,
  c.billable_or_pending_count,
  -- Pilot free-enrolment math: 3 free per provider. Anything beyond is billable.
  LEAST(3, c.billable_or_pending_count)                               AS free_enrolments_used,
  GREATEST(0, 3 - c.billable_or_pending_count)                        AS free_enrolments_remaining,
  GREATEST(0, c.billable_or_pending_count - 3)                        AS billable_count,
  -- Conversion rate: confirmed + presumed / total routed. Only meaningful
  -- once routings exist; NULL otherwise so the UI can render '—'.
  CASE
    WHEN COALESCE(r.total_routed, 0) > 0
      THEN ROUND(100.0 * c.billable_or_pending_count / r.total_routed, 1)
    ELSE NULL
  END                                                                 AS conversion_rate_pct
  FROM counts c
  LEFT JOIN routing r ON r.provider_id = c.provider_id;

COMMENT ON VIEW crm.vw_provider_billing_state IS
  'Derived per-provider billing + conversion state. Computes free_enrolments_used + remaining from actual crm.enrolments rows (status IN enrolled/presumed_enrolled), so it can never drift from the static crm.providers.free_enrolments_remaining column. Use this view instead of reading the static column. Conversion rate = (enrolled + presumed) / total_routed × 100.';

GRANT SELECT ON crm.vw_provider_billing_state TO authenticated;

-- DOWN
-- DROP VIEW IF EXISTS crm.vw_provider_billing_state;
