-- Migration 0114 — grant functions_writer INSERT on crm.lead_notes
-- Date: 2026-05-11
-- Author: Claude (Charlotte's platform session, lead #375 incident)
-- Reason: Migration 0109 (crm.lead_notes, shipped earlier today) created
--         the `functions_all_lead_notes` RLS policy targeting
--         `functions_writer` but ONLY granted table-level access to
--         `authenticated`. PostgreSQL evaluates GRANT before RLS, so the
--         Edge Function path that does `SET LOCAL ROLE functions_writer`
--         and INSERTs into crm.lead_notes failed with 42501 even though
--         the policy would have permitted the write.
--         Surfaced when lead #375 DQ'd on the fastrack form: Step 8
--         (UPDATE crm.enrolments + INSERT crm.lead_notes inside one
--         trx) threw 42501, dead-lettered, and left the lead at status
--         'open' in DB while the sheet got flipped to 'Lost' by Step 9.
--         Step 9 is now gated on Step 8 succeeding (commit 2fd8a12), so
--         this class of drift can't recur — but Step 8 itself needs the
--         grant to actually succeed.
--
--         Also defensively confirms the GRANT on crm.enrolments that
--         was supposed to carry over from migration 0001's `n8n_writer`
--         grant after the rename in 0002. Idempotent if already in place.
-- Related: supabase/functions/fastrack-receive/index.ts Step 8 trx,
--          supabase/migrations/0109_crm_lead_notes.sql line 97,
--          supabase/migrations/0001_init_pilot_schemas.sql line 397.

-- UP
GRANT SELECT, INSERT ON crm.lead_notes TO functions_writer;
GRANT USAGE, SELECT ON SEQUENCE crm.lead_notes_id_seq TO functions_writer;

-- Defensive re-grant on crm.enrolments. Should already be in place via
-- the 0001 n8n_writer grant + 0002 role rename. No-op if so.
GRANT SELECT, INSERT, UPDATE ON crm.enrolments TO functions_writer;

-- DOWN
-- REVOKE INSERT ON crm.lead_notes FROM functions_writer;
-- (intentionally not revoking the enrolments grant in DOWN — it was in
--  place pre-migration via 0001 + 0002)
