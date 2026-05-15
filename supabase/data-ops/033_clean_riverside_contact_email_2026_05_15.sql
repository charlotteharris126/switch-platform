-- Data-ops 033 — clean Riverside contact_email
-- Date:   2026-05-15
-- Owner:  Charlotte
-- Reason:
--   crm.providers.contact_email for riverside-training currently
--   carries `<\tFreya.Kelly@riverside-training.co.uk>` — angle brackets and
--   a literal tab character wrapping the address. Looks like a paste
--   from a `Name <email>` template that wasn't stripped. Breaks the
--   U2 send (Brevo would either bounce or fail-validate) the moment
--   TEST_MODE flips off.
--
--   Updating to the new live contact `Freya.Kelly@riverside-training.co.uk`
--   per Charlotte 2026-05-15 (Jane is no longer the day-to-day inbox).
--   Same audit row pattern as 028 / 032.
--
-- Related:
--   - netlify-employer-lead-router/index.ts sendProviderNotifyU2
--     reads contact_email directly; clean value flows through to
--     the Brevo recipient field.

BEGIN;

-- 1. Preview current value.
SELECT provider_id, contact_email
  FROM crm.providers
 WHERE provider_id = 'riverside-training';

-- 2. Clean.
UPDATE crm.providers
   SET contact_email = 'Freya.Kelly@riverside-training.co.uk',
       updated_at    = now()
 WHERE provider_id = 'riverside-training';

-- 3. Audit row.
SELECT audit.log_system_action(
  'data_ops:033',
  'clean_contact_email',
  'crm.providers',
  'riverside-training',
  jsonb_build_object('contact_email', '<\tFreya.Kelly@riverside-training.co.uk>'),
  jsonb_build_object('contact_email', 'Freya.Kelly@riverside-training.co.uk'),
  jsonb_build_object(
    'provider_id', 'riverside-training',
    'source', 'data_ops:033_clean_riverside_contact_email_2026_05_15',
    'reason', 'Strip angle brackets + tab character around the address; needed before TEST_MODE flips off and U2 starts hitting Jane directly'
  )
);

-- 4. Verification.
SELECT provider_id, contact_email
  FROM crm.providers
 WHERE provider_id = 'riverside-training';

COMMIT;
