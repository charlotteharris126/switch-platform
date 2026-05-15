-- Data-ops 033 — update Riverside contact (email + name)
-- Date:   2026-05-15
-- Owner:  Charlotte
-- Reason:
--   Two updates to crm.providers for riverside-training:
--
--   (1) contact_email was carrying `<\tjane@riverside-training.co.uk>`
--       (angle brackets + literal tab character wrapping the address,
--       from a `Name <email>` paste that wasn't stripped). Would break
--       the U2 send the moment TEST_MODE flips off.
--   (2) Per Charlotte 2026-05-15, Freya Kelly replaces Jane Preston
--       as the day-to-day Riverside contact for routed leads. Email
--       moves to Freya.Kelly@riverside-training.co.uk, contact_name
--       updates to "Freya Kelly" so the U2 greeting matches the
--       actual recipient.
--
--   Same audit row pattern as 028 / 032.
--
-- Related:
--   - netlify-employer-lead-router/index.ts sendProviderNotifyU2
--     reads contact_email + contact_name directly; values flow through
--     to the Brevo recipient field + the "Hi {{name}}" greeting line.

BEGIN;

-- 1. Preview current values.
SELECT provider_id, contact_name, contact_email
  FROM crm.providers
 WHERE provider_id = 'riverside-training';

-- 2. Update both fields.
UPDATE crm.providers
   SET contact_email = 'Freya.Kelly@riverside-training.co.uk',
       contact_name  = 'Freya Kelly',
       updated_at    = now()
 WHERE provider_id = 'riverside-training';

-- 3. Audit row.
SELECT audit.log_system_action(
  'data_ops:033',
  'update_contact_email_and_name',
  'crm.providers',
  'riverside-training',
  jsonb_build_object('contact_email', '<\tjane@riverside-training.co.uk>', 'contact_name', 'Jane Preston'),
  jsonb_build_object('contact_email', 'Freya.Kelly@riverside-training.co.uk', 'contact_name', 'Freya Kelly'),
  jsonb_build_object(
    'provider_id', 'riverside-training',
    'source', 'data_ops:033_clean_riverside_contact_email_2026_05_15',
    'reason', 'Freya replaces Jane as the day-to-day inbox + greeting target on U2; old contact_email value also carried angle brackets and a tab character that this update cleans'
  )
);

-- 4. Verification.
SELECT provider_id, contact_name, contact_email
  FROM crm.providers
 WHERE provider_id = 'riverside-training';

COMMIT;
