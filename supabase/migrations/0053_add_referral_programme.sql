-- Migration 0053 — add Switchable referral programme (data model + tracking + payout trigger)
-- Date: 2026-05-02
-- Author: Claude (Sasha session) with owner review
-- Reason: Build the platform side of the Switchable referral programme. Adds referral_code
--   and referrer_lead_id to leads.submissions, creates leads.referrals, and wires the
--   eligible-flip on confirmed/presumed enrolment. Voucher delivery is via Tremendous,
--   handled in the Edge Function layer (this migration only persists the trigger row).
-- Related:
--   - strategy/docs/referral-programme-scope.md (full programme design)
--   - platform/docs/data-architecture.md (schema docs in same commit)
--   - ClickUp 869d4ud8t (this build)
-- Schema version: bumps `leads` from v1.2 → v1.3 (lead payload schema + DB).

-- =============================================================================
-- UP
-- =============================================================================

-- Wrap the whole migration so partial failure rolls everything back.
-- Supabase SQL editor does NOT auto-wrap; supabase db push does. Belt and braces.
BEGIN;

-- 1. Referral code generator. Crockford base32 (no 0/1/I/L/O — no human ambiguity).
--    8 characters → ~10^12 codes. Collision probability negligible at our scale.
CREATE OR REPLACE FUNCTION leads.generate_referral_code()
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  alphabet CONSTANT TEXT := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  result TEXT := '';
  i INT;
BEGIN
  FOR i IN 1..8 LOOP
    result := result || substr(alphabet, (floor(random() * length(alphabet))::INT + 1), 1);
  END LOOP;
  RETURN result;
END;
$$;

-- 2. Extend leads.submissions with referral fields.
ALTER TABLE leads.submissions
  ADD COLUMN referral_code     TEXT,
  ADD COLUMN referrer_lead_id  BIGINT REFERENCES leads.submissions(id) ON DELETE SET NULL;

COMMENT ON COLUMN leads.submissions.referral_code IS
  '8-char Crockford base32 code unique to this lead. Used in outbound referral URLs (?ref=CODE). Auto-generated at insert.';
COMMENT ON COLUMN leads.submissions.referrer_lead_id IS
  'FK to the referring leads.submissions row, set when this lead was created via someone else''s referral_code. NULL for organic / paid social.';

-- 3. Backfill referral_code for every existing row. Defensive: roll a candidate per
--    row, re-roll on collision against the in-progress backfill. Cheaper than relying
--    on the UNIQUE INDEX in step 5 to surface dupes (which would abort the whole
--    transaction with no clear root cause).
DO $backfill$
DECLARE
  r RECORD;
  candidate TEXT;
  attempts INT;
BEGIN
  FOR r IN SELECT id FROM leads.submissions WHERE referral_code IS NULL ORDER BY id LOOP
    attempts := 0;
    LOOP
      candidate := leads.generate_referral_code();
      EXIT WHEN NOT EXISTS (SELECT 1 FROM leads.submissions WHERE referral_code = candidate);
      attempts := attempts + 1;
      IF attempts > 10 THEN
        RAISE EXCEPTION 'Backfill failed: could not find unique referral_code for leads.submissions.id=% after 10 attempts', r.id;
      END IF;
    END LOOP;
    UPDATE leads.submissions SET referral_code = candidate WHERE id = r.id;
  END LOOP;
END;
$backfill$;

-- 4. Lock referral_code: NOT NULL + UNIQUE.
ALTER TABLE leads.submissions
  ALTER COLUMN referral_code SET NOT NULL;

CREATE UNIQUE INDEX leads_submissions_referral_code_uniq
  ON leads.submissions (referral_code);

CREATE INDEX leads_submissions_referrer_lead_id_idx
  ON leads.submissions (referrer_lead_id)
 WHERE referrer_lead_id IS NOT NULL;

-- 5. Trigger to auto-populate referral_code on insert when caller doesn't supply one.
--    Loops until a non-colliding code lands. With 10^12 codes and pilot-scale volume,
--    the loop almost always exits on the first iteration.
CREATE OR REPLACE FUNCTION leads.set_referral_code_default()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  candidate TEXT;
  attempts INT := 0;
BEGIN
  IF NEW.referral_code IS NOT NULL THEN
    RETURN NEW;
  END IF;
  LOOP
    candidate := leads.generate_referral_code();
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM leads.submissions WHERE referral_code = candidate
    );
    attempts := attempts + 1;
    IF attempts > 10 THEN
      RAISE EXCEPTION 'Failed to generate unique referral_code after 10 attempts';
    END IF;
  END LOOP;
  NEW.referral_code := candidate;
  RETURN NEW;
END;
$$;

CREATE TRIGGER leads_submissions_referral_code_default
  BEFORE INSERT ON leads.submissions
  FOR EACH ROW
  EXECUTE FUNCTION leads.set_referral_code_default();

-- 6. The referrals table. One row per referred lead. status drives Tremendous payout.
CREATE TABLE leads.referrals (
  id                    BIGSERIAL PRIMARY KEY,
  schema_version        TEXT NOT NULL DEFAULT '1.0',
  referrer_lead_id      BIGINT NOT NULL REFERENCES leads.submissions(id) ON DELETE RESTRICT,
  referred_lead_id      BIGINT NOT NULL REFERENCES leads.submissions(id) ON DELETE RESTRICT,

  -- Lifecycle
  voucher_status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (voucher_status IN ('pending', 'eligible', 'paid', 'fraud_rejected')),
  voucher_amount_pence  INT NOT NULL DEFAULT 5000,
  needs_manual_review   BOOLEAN NOT NULL DEFAULT false,
  fraud_reason          TEXT,
  notes                 TEXT,

  -- Vendor (Tremendous in v1; left generic so we can swap)
  vendor                TEXT,
  vendor_payment_id     TEXT,
  vendor_payload        JSONB,

  -- Timestamps
  eligible_at           TIMESTAMPTZ,
  voucher_paid_at       TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A friend can only be referred once. Their referrer is whoever's code they used.
  CONSTRAINT leads_referrals_referred_lead_uniq UNIQUE (referred_lead_id),
  -- DB constraint catches the literal same-row case only. Edge Function is the
  -- actual self-referral defence (checks email / phone / address against referrer).
  CONSTRAINT leads_referrals_distinct_rows CHECK (referrer_lead_id <> referred_lead_id)
);

CREATE INDEX leads_referrals_referrer_idx
  ON leads.referrals (referrer_lead_id, voucher_status);
CREATE INDEX leads_referrals_status_idx
  ON leads.referrals (voucher_status, eligible_at)
 WHERE voucher_status IN ('pending', 'eligible');
CREATE INDEX leads_referrals_review_idx
  ON leads.referrals (needs_manual_review, eligible_at)
 WHERE needs_manual_review = true AND voucher_status = 'eligible';

COMMENT ON TABLE leads.referrals IS
  'One row per referred-lead. Created at submission time when ?ref=CODE resolves to a referrer. Status transitions: pending → eligible (on enrolment confirmation) → paid (Tremendous webhook). fraud_rejected is terminal.';
COMMENT ON COLUMN leads.referrals.needs_manual_review IS
  'Soft cap flag. Set true when the referrer has 10+ successful referrals in the last 90 days. Voucher does not auto-fire; owner reviews and clears manually. Set when voucher_status flips to eligible.';
COMMENT ON COLUMN leads.referrals.vendor IS
  'Voucher delivery vendor: tremendous, amazon_incentives, manual. Only set once payout is initiated.';

-- 7. updated_at trigger (mirrors the pattern used elsewhere in the schema).
CREATE OR REPLACE FUNCTION leads.referrals_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER leads_referrals_updated_at
  BEFORE UPDATE ON leads.referrals
  FOR EACH ROW
  EXECUTE FUNCTION leads.referrals_updated_at();

-- 8. Eligible-flip helper. Called from the enrolment-confirmation hook in the
--    crm layer (see follow-up patch to crm.ensure_open_enrolment / auto-flip).
--    Idempotent: a second call on the same submission is a no-op.
CREATE OR REPLACE FUNCTION leads.flip_referral_eligible(p_referred_lead_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_referral_id BIGINT;
  v_referrer_lead_id BIGINT;
  v_recent_paid_count INT;
  v_cap CONSTANT INT := 10;
  v_window CONSTANT INTERVAL := '90 days';
BEGIN
  -- Find the pending referral, if any.
  SELECT id, referrer_lead_id
    INTO v_referral_id, v_referrer_lead_id
    FROM leads.referrals
   WHERE referred_lead_id = p_referred_lead_id
     AND voucher_status = 'pending'
   LIMIT 1;

  IF v_referral_id IS NULL THEN
    RETURN false; -- no pending referral, nothing to do
  END IF;

  -- Soft cap: count this referrer's successful referrals (eligible or paid)
  -- in the last 90 days, excluding the row we're about to flip.
  SELECT COUNT(*) INTO v_recent_paid_count
    FROM leads.referrals
   WHERE referrer_lead_id = v_referrer_lead_id
     AND voucher_status IN ('eligible', 'paid')
     AND eligible_at >= now() - v_window
     AND id <> v_referral_id;

  UPDATE leads.referrals
     SET voucher_status = 'eligible',
         eligible_at = now(),
         needs_manual_review = (v_recent_paid_count >= v_cap)
   WHERE id = v_referral_id;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION leads.flip_referral_eligible(BIGINT) IS
  'Called from the enrolment-confirmation path. Flips a pending referral row to eligible and sets needs_manual_review when the referrer has hit the soft cap of 10 successful referrals in 90 days (rolling). Returns TRUE when a flip happened; FALSE when there was nothing to flip (no referral OR already flipped). Idempotent: a second call after the first flip is a no-op and returns FALSE.';

-- 9. RLS — same posture as other leads.* tables.
ALTER TABLE leads.referrals ENABLE ROW LEVEL SECURITY;

-- Service role has implicit full access (no policy needed).
-- Admin read for the dashboard:
CREATE POLICY admin_read_referrals
  ON leads.referrals
  FOR SELECT
  TO authenticated
  USING (admin.is_admin());

-- Admin update for manual-review clearance / notes / status overrides:
CREATE POLICY admin_update_referrals
  ON leads.referrals
  FOR UPDATE
  TO authenticated
  USING (admin.is_admin())
  WITH CHECK (admin.is_admin());

-- Read access for the analytics role (Iris / Mira / Metabase):
GRANT SELECT ON leads.referrals TO readonly_analytics;
GRANT SELECT ON leads.referrals TO authenticated;

-- 10. Bump the leads schema version marker on every row. Earlier migrations bumped
--     to '1.0', '1.1', '1.2'; the referral fields are now part of the contract for
--     every row, so flip them all to '1.3'.
UPDATE leads.submissions
   SET schema_version = '1.3'
 WHERE schema_version IN ('1.0', '1.1', '1.2');

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS admin_update_referrals ON leads.referrals;
-- DROP POLICY IF EXISTS admin_read_referrals ON leads.referrals;
-- REVOKE SELECT ON leads.referrals FROM authenticated;
-- REVOKE SELECT ON leads.referrals FROM readonly_analytics;
-- DROP TRIGGER IF EXISTS leads_referrals_updated_at ON leads.referrals;
-- DROP FUNCTION IF EXISTS leads.referrals_updated_at();
-- DROP FUNCTION IF EXISTS leads.flip_referral_eligible(BIGINT);
-- DROP TABLE IF EXISTS leads.referrals;
-- DROP TRIGGER IF EXISTS leads_submissions_referral_code_default ON leads.submissions;
-- DROP FUNCTION IF EXISTS leads.set_referral_code_default();
-- DROP INDEX IF EXISTS leads.leads_submissions_referrer_lead_id_idx;
-- DROP INDEX IF EXISTS leads.leads_submissions_referral_code_uniq;
-- ALTER TABLE leads.submissions DROP COLUMN IF EXISTS referrer_lead_id;
-- ALTER TABLE leads.submissions DROP COLUMN IF EXISTS referral_code;
-- DROP FUNCTION IF EXISTS leads.generate_referral_code();
-- UPDATE leads.submissions SET schema_version = '1.2' WHERE schema_version = '1.3';
-- COMMIT;
