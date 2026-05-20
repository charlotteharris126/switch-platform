-- Migration 0154 — Per-user LA scoping of provider notifications
-- Date:   2026-05-20
-- Author: Sasha (Charlotte's session)
-- Reason:
--   Today new-lead emails go to provider.contact_email only (Andy at EMS),
--   and callback-note emails fan out to every active crm.provider_users row
--   for the provider. EMS hired three regional managers (George Taylor,
--   Jake Balfour, Nick Rodgers) who each only want emails for THEIR LAs —
--   not every Tees Valley lead. Daniel Mearns is a catch-all account
--   manager who wants every notification (like Andy on new leads).
--
--   notification_las TEXT[] on crm.provider_users carries the user's LA
--   scope. NULL or empty array = catch-all (receive every notification
--   for the provider, regardless of the lead's LA). Non-empty = receive
--   only when the lead's la is in the array.
--
--   Slugs match the LA values produced by the funded form (the slug used
--   in submission.la, e.g. 'stockton-on-tees', 'hartlepool',
--   'middlesbrough', 'darlington', 'redcar-and-cleveland'). Source of
--   truth for the slug list per region is switchable/site/deploy/data/
--   regions/*.yml.
--
--   No portal UI for this yet — DB-only edits via Charlotte / Sasha. The
--   next pilot provider with multi-user notification needs gets a self-
--   serve UI in /provider/account.
--
-- Impact assessment (per .claude/rules/data-infrastructure.md §8):
--   1. Change: additive — one nullable TEXT[] column on crm.provider_users,
--      plus five UPDATE rows for EMS (the regional managers). All
--      existing rows default to NULL → catch-all behaviour.
--   2. Readers (new): _shared/route-lead.ts sendProviderNotification
--      (selects rows matching submission.la for the CC list);
--      admin-notify-callback Edge Function (same query, mirrored).
--   3. Writers: admin only, hand-written SQL or future portal UI. No
--      Edge Function writes this column today.
--   4. Schema version: no payload contract; no version bump.
--   5. Data migration: five UPDATE rows seeded inline. Reversible by
--      setting back to NULL.
--   6. Role/policy: existing crm.provider_users policies (admin /
--      functions_writer / readonly_analytics) cover the new column —
--      no policy change needed.
--   7. Rollback: DOWN drops the column. The two Edge Functions degrade
--      gracefully (column missing → query falls back to catch-all
--      behaviour) BUT for clean rollback both functions should be
--      reverted in lockstep.
--   8. Sign-off: owner (this session, 2026-05-20).
--
-- Related: _shared/route-lead.ts (sendProviderNotification CC list)
--          admin-notify-callback (recipient selection)

BEGIN;

ALTER TABLE crm.provider_users
  ADD COLUMN notification_las TEXT[];

COMMENT ON COLUMN crm.provider_users.notification_las IS
  'Optional LA-slug scope for notification emails. NULL or empty = catch-all (receive every notification for this provider, regardless of submission.la). Non-empty = receive notification only when submission.la is in the array. Slugs match the LA values produced by the funded form (e.g. ''stockton-on-tees''). Read by _shared/route-lead.ts sendProviderNotification and admin-notify-callback.';

-- Seed: EMS regional managers
UPDATE crm.provider_users
   SET notification_las = ARRAY['stockton-on-tees', 'hartlepool'],
       updated_at       = now()
 WHERE provider_id  = 'enterprise-made-simple'
   AND contact_email = 'george.taylor@enterprisemadesimple.co.uk';

UPDATE crm.provider_users
   SET notification_las = ARRAY['middlesbrough', 'darlington'],
       updated_at       = now()
 WHERE provider_id  = 'enterprise-made-simple'
   AND contact_email = 'jake.balfour@enterprisemadesimple.co.uk';

UPDATE crm.provider_users
   SET notification_las = ARRAY['redcar-and-cleveland'],
       updated_at       = now()
 WHERE provider_id  = 'enterprise-made-simple'
   AND contact_email = 'nick.rodgers@enterprisemadesimple.co.uk';

-- Andy and Daniel are intentionally left NULL (catch-all). No row touched
-- for them in this migration — default-NULL on the new column = catch-all
-- semantics.

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- ALTER TABLE crm.provider_users DROP COLUMN notification_las;
-- COMMIT;
