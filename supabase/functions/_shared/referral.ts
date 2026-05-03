// Shared referral programme processing for the lead-ingest pipeline.
//
// Used by netlify-lead-router (fast path) and netlify-leads-reconcile (slow
// path). Both paths must apply identical anti-fraud and referral-row insertion
// so a webhook outage doesn't lose voucher attribution.
//
// Migration 0053 introduced the data model (leads.submissions.referrer_lead_id +
// leads.referrals). Migration 0054/0055 wired the eligible-flip into the
// enrolment-confirmation paths. This module owns the fraud detection and
// row-insert side of the pipeline.
//
// Caller responsibilities:
//   - Pass an open postgres-js client. processReferral runs its own transaction
//     via sql.begin and assumes the client is connected to a role that can
//     SET LOCAL ROLE functions_writer (i.e. the SUPABASE_DB_URL superuser).
//   - Pass the canonical submission row (already inserted) plus the new row's
//     submission_id. processReferral does not insert the submission itself.

import type { Sql } from "npm:postgres@3";
import type { CanonicalSubmission, JsonValue } from "./ingest.ts";

// Hidden form fields the site may set when ?ref=CODE is present on the URL.
// Mable's site work captures the URL param into a hidden input; one of these
// names will land in body.data. `ref` is the canonical name; the others are
// safety nets if the site implementation lands on a different convention.
const REF_FORM_FIELD_NAMES = ["ref", "ref_code", "referral_code"] as const;

export function extractRefCode(body: Record<string, JsonValue>): string | null {
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const dataObj = data as Record<string, JsonValue>;
  for (const name of REF_FORM_FIELD_NAMES) {
    const v = dataObj[name];
    if (typeof v === "string" && v.trim().length > 0) {
      // Crockford base32 codes are uppercase by convention; normalise so a
      // user pasting the link in lowercase still resolves.
      return v.trim().toUpperCase();
    }
  }
  return null;
}

interface ReferrerRow {
  id: number;
  email: string | null;
  phone: string | null;
  postcode: string | null;
  la: string | null;
}

export async function processReferral(
  sql: Sql,
  newSubmissionId: number,
  refCode: string,
  row: CanonicalSubmission,
): Promise<void> {
  // 1. Look up the referrer. If no match, the link was bad — silent skip.
  const referrers = await sql<Array<ReferrerRow>>`
    SELECT id, email, phone, postcode, la
      FROM leads.submissions
     WHERE referral_code = ${refCode}
       AND id <> ${newSubmissionId}
     LIMIT 1
  `;
  if (referrers.length === 0) {
    console.log(`referral: ref_code=${refCode} did not match any lead, ignoring`);
    return;
  }
  const referrer = referrers[0];

  // 2. Anti-fraud: self-referral by contact details.
  const sameEmail =
    !!row.email &&
    !!referrer.email &&
    normaliseEmailForCompare(row.email) === normaliseEmailForCompare(referrer.email);
  const samePhone =
    !!row.phone &&
    !!referrer.phone &&
    normalisePhoneForCompare(row.phone) === normalisePhoneForCompare(referrer.phone);
  // Address proxy: postcode (self-funded) or local authority (funded).
  const samePostcode =
    !!row.postcode &&
    !!referrer.postcode &&
    normalisePostcodeForCompare(row.postcode) === normalisePostcodeForCompare(referrer.postcode);
  const sameLa = !!row.la && !!referrer.la && row.la === referrer.la;
  const sameAddress = samePostcode || sameLa;

  // 3. Anti-fraud: friend's email already exists in the funnel as a fresh
  //    submission (parent_submission_id IS NULL excludes legitimate
  //    re-applications, which carry the parent's attribution and aren't novel
  //    introductions).
  let duplicateEmail = false;
  if (row.email) {
    const existing = await sql<Array<{ id: number }>>`
      SELECT id FROM leads.submissions
       WHERE LOWER(email) = LOWER(${row.email})
         AND id <> ${newSubmissionId}
         AND parent_submission_id IS NULL
       LIMIT 1
    `;
    duplicateEmail = existing.length > 0;
  }

  let fraudReason: string | null = null;
  if (sameEmail) fraudReason = "self_referral_email";
  else if (samePhone) fraudReason = "self_referral_phone";
  else if (sameAddress) fraudReason = "self_referral_address";
  else if (duplicateEmail) fraudReason = "duplicate_email_already_in_funnel";

  // 4. Insert the referral row inside a transaction. fraud_rejected → no
  //    referrer link on the submission. pending → set referrer_lead_id and
  //    create a pending referral row that the eligible-flip will pick up.
  await sql.begin(async (trx) => {
    await trx`SET LOCAL ROLE functions_writer`;

    if (fraudReason) {
      await trx`
        INSERT INTO leads.referrals (referrer_lead_id, referred_lead_id, voucher_status, fraud_reason)
        VALUES (${referrer.id}, ${newSubmissionId}, 'fraud_rejected', ${fraudReason})
        ON CONFLICT (referred_lead_id) DO NOTHING
      `;
      console.log(
        `referral: lead=${newSubmissionId} ref_code=${refCode} referrer=${referrer.id} → fraud_rejected (${fraudReason})`,
      );
      return;
    }

    await trx`
      UPDATE leads.submissions
         SET referrer_lead_id = ${referrer.id}
       WHERE id = ${newSubmissionId}
    `;
    await trx`
      INSERT INTO leads.referrals (referrer_lead_id, referred_lead_id, voucher_status)
      VALUES (${referrer.id}, ${newSubmissionId}, 'pending')
      ON CONFLICT (referred_lead_id) DO NOTHING
    `;
    console.log(
      `referral: lead=${newSubmissionId} ref_code=${refCode} referrer=${referrer.id} → pending`,
    );
  });
}

function normaliseEmailForCompare(s: string): string {
  return s.trim().toLowerCase();
}

function normalisePhoneForCompare(s: string): string {
  // Strip everything except digits. Country-code prefixes are tolerated by the
  // length difference catching duplicates anyway; this is a coarse check.
  return s.replace(/[^\d]/g, "");
}

function normalisePostcodeForCompare(s: string): string {
  return s.replace(/\s+/g, "").toUpperCase();
}
