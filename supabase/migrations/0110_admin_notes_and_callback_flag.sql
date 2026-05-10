-- Migration 0110 — admin-authored notes + callback-requested flag
-- Date:    2026-05-10
-- Author:  Claude (platform Session 39) on Charlotte's instruction
-- Reason:  Charlotte (admin) needs to add notes to a lead from the
--          admin surface; those notes show up in the provider's notes
--          log alongside their own; an optional toggle on the admin
--          compose form raises a "callback requested" flag on the
--          lead's enrolment row, which pins the lead to the top of
--          the provider's list, lights up sidebar/nav counts, fires
--          a utility email, and clears as soon as the provider marks
--          any new outcome on that lead.
--
--          Status enum NOT extended. The earlier proposal of a
--          'lead_re_engaged' status was dropped — the flag is a
--          decoupled queue marker, not a lifecycle position. Status
--          remains the source of truth for "where in the call
--          sequence is this lead", flag describes "is there an
--          outstanding admin nudge".
--
--          Note authorship gets two new columns: author_role
--          (provider / admin / system) and author_user_id (auth.uid
--          of whoever wrote it, regardless of role). Old rows
--          backfilled to author_role='provider' + author_user_id
--          from crm.provider_users.auth_user_id. provider_user_id
--          stays NOT NULL only for provider-authored notes — admins
--          set it to NULL.
--
--          Provider read-state: read_by_provider_at on lead_notes
--          tracks "has any provider user opened the lead since this
--          note was added". Cleared on view via a Server Action
--          (no DB trigger — provider auth context flows through the
--          UPDATE which is RLS-gated on provider_id match).
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: 3 new columns on crm.lead_notes (author_role,
--      author_user_id, read_by_provider_at), 2 new columns on
--      crm.enrolments (callback_requested_at, callback_requested_by),
--      1 new RLS policy (admin INSERT on lead_notes), backfill of
--      author_role/author_user_id, NOT NULL relaxation on
--      provider_user_id.
--   2. Readers affected: provider lead detail page (notes log will
--      now render admin notes too); provider leads list (will read
--      callback_requested_at for pinning); admin lead detail page
--      (new notes panel + callback toggle ships in this session).
--   3. Writers: new addAdminNoteAction Server Action (this session);
--      markOutcomeAction extended to clear callback flag in the
--      same UPDATE.
--   4. Schema version: not affected.
--   5. Data migration: backfill author_role='provider' for existing
--      rows, copy auth_user_id from crm.provider_users into
--      author_user_id. Idempotent.
--   6. Role/policy: new admin_insert_lead_notes policy; existing
--      provider policies untouched. Service role unaffected.
--   7. Rollback: REVOKE INSERT, DROP POLICY, drop the new columns.
--      Server Actions revert to the pre-0110 shape (provider notes
--      only, no callback flag).
--   8. Sign-off: owner (this session, 2026-05-10).
-- Related: 0109 (lead_notes table), 0096 (provider RLS policies),
--          0014 (admin.is_admin pattern).

BEGIN;

-- ============================================================================
-- 1. crm.lead_notes — author role + author user + read state
-- ============================================================================

ALTER TABLE crm.lead_notes
  ADD COLUMN author_role TEXT NOT NULL DEFAULT 'provider'
    CHECK (author_role IN ('provider', 'admin', 'system')),
  ADD COLUMN author_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN read_by_provider_at TIMESTAMPTZ;

-- Backfill author_user_id on existing rows from the provider_user_id link.
UPDATE crm.lead_notes ln
SET author_user_id = pu.auth_user_id
FROM crm.provider_users pu
WHERE pu.id = ln.provider_user_id
  AND ln.author_user_id IS NULL;

-- provider_user_id stays NOT NULL for provider-authored rows but admins
-- write rows without one — relax the column constraint.
ALTER TABLE crm.lead_notes
  ALTER COLUMN provider_user_id DROP NOT NULL;

-- New CHECK: provider notes must carry provider_user_id; admin/system
-- notes don't. Keeps the historical invariant intact for old rows.
ALTER TABLE crm.lead_notes
  ADD CONSTRAINT lead_notes_author_shape_chk CHECK (
    (author_role = 'provider' AND provider_user_id IS NOT NULL)
    OR (author_role IN ('admin', 'system'))
  );

CREATE INDEX lead_notes_unread_idx
  ON crm.lead_notes (submission_id)
  WHERE read_by_provider_at IS NULL AND author_role = 'admin';

COMMENT ON COLUMN crm.lead_notes.author_role IS
  'Who authored this note: provider (any provider_user), admin (Charlotte from /admin), or system (cron / Edge Function).';
COMMENT ON COLUMN crm.lead_notes.author_user_id IS
  'auth.users.id of whoever wrote the note. Always populated for provider/admin; system notes may carry a service-account uuid or NULL.';
COMMENT ON COLUMN crm.lead_notes.read_by_provider_at IS
  'Timestamp of when any provider user first opened the lead detail page after this note was added. NULL = unread by the provider side. Used for the red-dot indicator on lead rows and the "needs review" home banner.';

-- ============================================================================
-- 2. crm.enrolments — callback-requested flag
-- ============================================================================

ALTER TABLE crm.enrolments
  ADD COLUMN callback_requested_at TIMESTAMPTZ,
  ADD COLUMN callback_requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX enrolments_callback_requested_idx
  ON crm.enrolments (provider_id, callback_requested_at)
  WHERE callback_requested_at IS NOT NULL;

COMMENT ON COLUMN crm.enrolments.callback_requested_at IS
  'Timestamp set by an admin to flag this lead as needing the provider''s attention (e.g. learner replied asking for a callback). Pins the lead to the top of the provider''s leads list, fires a utility email, and counts in the "Needs callback" sidebar tile and nav badge. Cleared automatically when markOutcomeAction lands any new outcome — flag means "outstanding admin nudge", clearing means "provider acted".';
COMMENT ON COLUMN crm.enrolments.callback_requested_by IS
  'auth.users.id of the admin who raised the flag. For audit + telemetry, not displayed to the provider.';

-- ============================================================================
-- 3. RLS — admin INSERT on lead_notes
-- ============================================================================
-- Admins already have admin_all_lead_notes (FOR ALL via admin.is_admin())
-- from migration 0109. That policy already covers admin INSERT — we don't
-- need a new policy for admin write. We just confirm here that it's still
-- in place (idempotent comment, no-op SQL).
--
-- Provider read continues to be scoped by provider_id = caller's helper
-- result. Admin notes on a provider's lead carry provider_id = that
-- provider's id (the Server Action sets it from the submission's
-- primary_routed_to), so provider_read_lead_notes shows them.

-- ============================================================================
-- 4. Provider read of admin notes via embedded auth.users author lookup
-- ============================================================================
-- The provider portal needs to render the admin author's display name
-- ("Charlotte from Switchable") when admin notes appear. auth.users is
-- not exposed in the Data API. Two options:
--   (a) duplicate the admin display_name into a column on lead_notes
--   (b) provide a SECURITY DEFINER helper that returns display name
--       given an auth_user_id, callable from the portal
-- Going with (a) for simplicity — the admin's display name is stable
-- per session and stored on the row at write-time. Renaming admins
-- doesn't retroactively rewrite old notes (acceptable; audit trail).

ALTER TABLE crm.lead_notes
  ADD COLUMN author_display_name TEXT;

COMMENT ON COLUMN crm.lead_notes.author_display_name IS
  'Snapshot of the author''s display name at note-write time. Provider notes default to provider_users.display_name; admin notes default to "Charlotte from Switchable" (set server-side). Snapshot rather than join to keep render fast and avoid exposing auth.users.';

COMMIT;

-- ============================================================================
-- DOWN
-- ============================================================================
-- BEGIN;
-- ALTER TABLE crm.lead_notes DROP COLUMN author_display_name;
-- DROP INDEX IF EXISTS crm.enrolments_callback_requested_idx;
-- ALTER TABLE crm.enrolments
--   DROP COLUMN callback_requested_by,
--   DROP COLUMN callback_requested_at;
-- DROP INDEX IF EXISTS crm.lead_notes_unread_idx;
-- ALTER TABLE crm.lead_notes
--   DROP CONSTRAINT IF EXISTS lead_notes_author_shape_chk,
--   ALTER COLUMN provider_user_id SET NOT NULL,
--   DROP COLUMN read_by_provider_at,
--   DROP COLUMN author_user_id,
--   DROP COLUMN author_role,
--   DROP COLUMN author_display_name;
-- COMMIT;
