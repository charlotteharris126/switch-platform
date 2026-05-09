-- Data fix 018 — Consolidate duplicate DQ reasons, 2026-05-09
-- Date:   2026-05-09
-- Owner:  Charlotte (decided 2026-05-09 after spotting the duplicates)
-- Reason: leads.submissions.dq_reason has free-text values written by the
--         Switchable funded form JS. Three pairs of duplicates surfaced:
--           - 'level'    (3 rows) → same meaning as 'overqualified'
--           - 'qual'     (2 rows) → same meaning as 'overqualified'
--           - 'location' (3 rows) → same meaning as 'region_mismatch'
--         Total 8 rows need consolidating. Canonical values are 'overqualified'
--         (currently 19 rows) and 'region_mismatch' (currently 28 rows).
--
--         postcode_mismatch (6 rows) is left as-is — it's genuinely more
--         granular than region_mismatch (lives in Tees Valley but specific
--         postcode outside the eligible LIFT boroughs etc.). Distinct
--         analytical value, not a duplicate.
--
--         Form-side cleanup (separate from this script): the Switchable
--         funded form JS writes the deprecated values from a `qual-fail-reason`
--         hidden input. Mable owns that fix — pushed to switchable/site/
--         handoff. Until she ships, future submissions will keep writing
--         deprecated values; data-ops/018 just patches existing data.
--         A second pass of this script will be needed once Mable's fix lands
--         to clean any new submissions that arrived in the gap.
--
--         The matrix.json schema doc at switchable/site/deploy/deploy/data/
--         matrix.json line 384 lists 'age | location | level' as documented
--         enum values — Mable's fix should also update that to remove the
--         deprecated values.
--
-- Effect:
--   1. UPDATE leads.submissions: 'level' / 'qual' → 'overqualified' (5 rows)
--   2. UPDATE leads.submissions: 'location' → 'region_mismatch' (3 rows)
--   3. Audit log entries for each of the 8 changes.
--   4. Trigger 0098 will auto-fire crm.sync_leads_to_brevo for each row,
--      pushing SW_DQ_REASON updates to Brevo. (Note: form-DQ contacts ARE
--      in Brevo as no_match. The trigger fires once per UPDATE, then
--      admin-brevo-resync runs async per submission.)
--
-- Pre-condition: ingest.ts doesn't write any of the deprecated values
-- itself (verified — they come from form-side hidden inputs only).

BEGIN;

-- ─── 1. UPDATEs: deprecated → canonical ─────────────────────────────────

UPDATE leads.submissions
   SET dq_reason  = 'overqualified',
       updated_at = now()
 WHERE dq_reason = 'level';

UPDATE leads.submissions
   SET dq_reason  = 'overqualified',
       updated_at = now()
 WHERE dq_reason = 'qual';

UPDATE leads.submissions
   SET dq_reason  = 'region_mismatch',
       updated_at = now()
 WHERE dq_reason = 'location';

-- ─── 2. Audit log entries ───────────────────────────────────────────────
-- One audit entry per affected row, attributed to the data-ops script.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT id, dq_reason
      FROM leads.submissions
     WHERE id IN (
       SELECT id FROM leads.submissions
        WHERE dq_reason = 'overqualified'
          AND updated_at > now() - INTERVAL '5 minutes'
     )
  LOOP
    PERFORM audit.log_system_action(
      p_actor        := 'system:manual:charlotte',
      p_action       := 'dq_reason_consolidation',
      p_target_table := 'leads.submissions',
      p_target_id    := r.id::text,
      p_before       := jsonb_build_object('dq_reason', 'level OR qual'),
      p_after        := jsonb_build_object('dq_reason', 'overqualified'),
      p_context      := jsonb_build_object(
        'reason', 'Consolidated deprecated DQ reasons (level, qual) into canonical overqualified per data hygiene cleanup.',
        'data_ops_script', '018_dq_reason_consolidation_2026_05_09'
      )
    );
  END LOOP;

  FOR r IN
    SELECT id, dq_reason
      FROM leads.submissions
     WHERE id IN (
       SELECT id FROM leads.submissions
        WHERE dq_reason = 'region_mismatch'
          AND updated_at > now() - INTERVAL '5 minutes'
     )
  LOOP
    PERFORM audit.log_system_action(
      p_actor        := 'system:manual:charlotte',
      p_action       := 'dq_reason_consolidation',
      p_target_table := 'leads.submissions',
      p_target_id    := r.id::text,
      p_before       := jsonb_build_object('dq_reason', 'location'),
      p_after        := jsonb_build_object('dq_reason', 'region_mismatch'),
      p_context      := jsonb_build_object(
        'reason', 'Consolidated deprecated DQ reason (location) into canonical region_mismatch per data hygiene cleanup.',
        'data_ops_script', '018_dq_reason_consolidation_2026_05_09'
      )
    );
  END LOOP;
END $$;

-- ─── Verification ──────────────────────────────────────────────────────
SELECT dq_reason, COUNT(*) AS n
  FROM leads.submissions
 WHERE is_dq = true
   AND dq_reason IN ('overqualified', 'region_mismatch', 'level', 'qual', 'location', 'postcode_mismatch')
 GROUP BY dq_reason
 ORDER BY n DESC;

-- Expected after this script:
--   overqualified    24  (was 19 + 3 'level' + 2 'qual')
--   region_mismatch  31  (was 28 + 3 'location')
--   postcode_mismatch 6  (unchanged)
--   level / qual / location: 0 rows each (all consolidated)

COMMIT;
