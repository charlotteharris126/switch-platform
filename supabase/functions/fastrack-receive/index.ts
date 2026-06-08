// Edge Function: fastrack-receive
//
// Receives a Netlify Forms outgoing webhook for `fastrack-funded-v1` (the
// Fastrack form on /funded/thank-you/, lead-to-enrol uplift Phase 2). Reads
// the parent funded submission via `client_nonce` (set by the funded form's
// pre-submit JS, carried through the post-submit redirect as `?ref=<uuid>`,
// posted back as `parent_ref` from the fastrack form's hidden field), then:
//
//   1. Verify Netlify webhook (no shared secret pattern in use across the
//      site - URL-secrecy + TLS, same as netlify-lead-router).
//   2. Parse and normalise the fastrack payload (schema 1.0, see
//      switchable/site/docs/funded-funnel-architecture.md).
//   3. Look up parent submission. Missing parent → leads.dead_letter,
//      return 200 (no data lost).
//   4. Compute l3_mismatch_flag and cohort_decline_flag.
//   5. INSERT into leads.fastrack_submissions.
//   6. Stamp leads.submissions.fastracked_at on the parent.
//   7. Asymmetric marketing: only an explicit body.marketing_opt_in === true
//      writes a fresh crm.consent_history row. False / blank does NOT
//      downgrade prior consent (parent submission stays source of truth;
//      withdrawal flows through Brevo unsubscribe links).
//   8. DQ flip: l3_mismatch (precedence) or cohort_decline ⇒ UPDATE
//      crm.enrolments SET status='lost', lost_reason=<reason>. Migration
//      0089 extends the lost_reason CHECK constraint to permit both new
//      values.
//   9. Sheet update: call provider-sheet-appender-v2.gs in
//      "update_by_submission_id" mode to set Fastrack columns (and on a
//      DQ, Status + Lost Reason) on the parent lead's existing row.
//      Best-effort - failures land in leads.dead_letter as a separate
//      source so they're visible without poisoning the success path.
//  10. Return 200 with the new fastrack_submission_id.
//
// Owner-routes-leads pattern: this function does NOT email the provider.
// Sheet update is the channel; provider sees fastrack data on the existing
// row of their sheet. An optional Brevo notification step is deliberately
// deferred until Andy asks for it.

import postgres from "npm:postgres@3";
import { sendBrevoEmail, sendTransactional } from "../_shared/brevo.ts";
import { fireSaveNumberSms } from "../_shared/sms-utility.ts";
import {
  SUBMISSION_FULL_COLUMNS,
  type ProviderRow,
  type SubmissionRow,
} from "../_shared/route-lead.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error(
    "SUPABASE_DB_URL is not set. This should be auto-injected by Supabase for every Edge Function.",
  );
}

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

const SHEETS_APPEND_TOKEN = Deno.env.get("SHEETS_APPEND_TOKEN");

const VOICE_OF_LEARNER_MAX_LEN = 1000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LostReason = "l3_mismatch_self_reported" | "cohort_decline";

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch (_err) {
    return await deadLetter(null, "fastrack: invalid JSON body");
  }

  const body = rawBody as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return await deadLetter(rawBody, "fastrack: request body is not an object");
  }

  const data =
    body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : ({} as Record<string, unknown>);

  const formName = firstString(
    body.form_name,
    body["form-name"],
    data.form_name,
    data["form-name"],
  );
  if (formName !== "fastrack-funded-v1") {
    return await deadLetter(
      rawBody,
      `fastrack: unexpected form_name=${formName ?? "(missing)"}`,
    );
  }

  const parentRefRaw = firstString(data.parent_ref);
  if (!parentRefRaw || !UUID_RE.test(parentRefRaw.trim())) {
    return await deadLetter(rawBody, "fastrack: parent_ref missing or not a UUID");
  }
  const parentRef = parentRefRaw.trim().toLowerCase();

  // Step 3: lookup parent
  const parentRows = await sql<Array<{
    id: number;
    prior_level_3_or_higher: boolean | null;
    primary_routed_to: string | null;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    funding_category: string | null;
  }>>`
    SELECT id, prior_level_3_or_higher, primary_routed_to, email,
           first_name, last_name, funding_category
      FROM leads.submissions
     WHERE client_nonce = ${parentRef}
     LIMIT 1
  `;
  const parent = parentRows[0];
  if (!parent) {
    return await deadLetter(rawBody, "fastrack: parent client_nonce not found");
  }

  // Step 4: compute flags
  const cohortConfirmed = toBool(data.cohort_confirmed);
  const cohortDeclineFlag = cohortConfirmed === false;
  const l3Reconfirmed = toBool(data.l3_reconfirmed);
  // Architecture spec: any "I do hold a Level 3" answer at this step is
  // operationally a mismatch. Parent's prior_level_3_or_higher is informational
  // only - the cross-check question itself is authoritative.
  const l3MismatchFlag = l3Reconfirmed === true;

  // Step 5: insert child row
  const submittedAt = firstString(data.submitted_at) ?? new Date().toISOString();
  const transportHelp = toBool(data.transport_help_requested);
  const docsReady = toBool(data.docs_ready);
  // AEB fastrack only (team-leading): learner reconfirms they earn under £30k.
  // NULL on FCFJ fastracks (the question isn't asked). Extra due-diligence signal.
  const earningsReconfirmed = toBool(data.earnings_reconfirmed);
  const voiceRaw = firstString(data.voice_of_learner_intro);
  const voice = voiceRaw
    ? voiceRaw.trim().slice(0, VOICE_OF_LEARNER_MAX_LEN)
    : null;
  const termsAccepted = toBool(data.terms_accepted) ?? false;
  const marketingOptIn = toBool(data.marketing_opt_in) ?? false;

  let fastrackId: number | null;
  try {
    fastrackId = await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      // ON CONFLICT DO NOTHING against the (parent_submission_id, submitted_at)
      // unique index (migration 0186). The thank-you page intermittently
      // double-POSTs; the repeat carries the same client submitted_at, so it
      // conflicts and returns no row. We treat that as an idempotent no-op
      // below (no second insert, no second provider notification).
      const inserted = await trx<Array<{ id: number }>>`
        INSERT INTO leads.fastrack_submissions (
          schema_version,
          parent_submission_id,
          submitted_at,
          cohort_confirmed,
          transport_help_requested,
          docs_ready,
          l3_reconfirmed,
          l3_mismatch_flag,
          earnings_reconfirmed,
          voice_of_learner_intro,
          terms_accepted,
          marketing_opt_in,
          raw_payload,
          user_agent
        ) VALUES (
          '1.0',
          ${parent.id},
          ${submittedAt},
          ${cohortConfirmed},
          ${transportHelp},
          ${docsReady},
          ${l3Reconfirmed},
          ${l3MismatchFlag},
          ${earningsReconfirmed},
          ${voice},
          ${termsAccepted},
          ${marketingOptIn},
          ${trx.json(rawBody as never)},
          ${firstString(body.user_agent, data.user_agent) ?? null}
        )
        ON CONFLICT (parent_submission_id, submitted_at) DO NOTHING
        RETURNING id
      `;
      return inserted.length > 0 ? Number(inserted[0].id) : null;
    });
  } catch (err) {
    return await deadLetter(
      rawBody,
      `fastrack: insert failed: ${describeError(err)}`,
    );
  }

  // Duplicate POST (same lead + submitted_at): the first POST already inserted
  // the row, wrote the sheet, ran the qualification logic and sent the provider
  // notification. Return ok without repeating any of it.
  if (fastrackId === null) {
    return json({ status: "ok", duplicate: true, parent_submission_id: parent.id });
  }

  // Step 6: stamp fastracked_at on parent (best-effort, non-fatal)
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        UPDATE leads.submissions
           SET fastracked_at = now()
         WHERE id = ${parent.id}
      `;
    });
  } catch (err) {
    console.error(
      "fastrack: stamp fastracked_at failed (non-fatal):",
      describeError(err),
    );
  }

  // Step 7: asymmetric marketing consent. Only an explicit `true` writes a
  // fresh row; `false` / blank never downgrades prior consent.
  if (marketingOptIn === true && parent.email) {
    try {
      await sql.begin(async (trx) => {
        await trx`SET LOCAL ROLE functions_writer`;
        await trx`
          INSERT INTO crm.consent_history (
            submission_id,
            contact_email,
            field_changed,
            old_value,
            new_value,
            changed_by,
            source,
            metadata
          ) VALUES (
            ${parent.id},
            ${parent.email!.toLowerCase()},
            'email_campaigns_subscription',
            NULL,
            'true',
            'contact',
            'form',
            ${trx.json({
              source_form: "fastrack-funded-v1",
              fastrack_submission_id: fastrackId,
            })}
          )
        `;
      });
    } catch (err) {
      console.error(
        "fastrack: consent_history insert failed (non-fatal):",
        describeError(err),
      );
    }
  }

  // Step 8: DQ flip. L3 mismatch wins precedence over cohort decline.
  let lostReason: LostReason | null = null;
  if (l3MismatchFlag) lostReason = "l3_mismatch_self_reported";
  else if (cohortDeclineFlag) lostReason = "cohort_decline";

  // Tracks whether Step 8's DB flip actually succeeded. When false, we
  // must NOT tell the sheet to mark this lead as Lost — otherwise the
  // DB stays "open" while the sheet says "Lost", which is exactly the
  // divergence lead #375 hit (sheet flipped, DB didn't, no visible
  // alert until owner noticed two days later).
  let flipSucceeded = false;

  if (lostReason) {
    const reasonHuman = lostReasonHumanText(lostReason);
    const noteBody =
      lostReason === "l3_mismatch_self_reported"
        ? `Learner self-flagged L3 mismatch on the fastrack form. Auto-moved to Lost (reason: ${reasonHuman}).`
        : `Learner declined the cohort dates on the fastrack form. Auto-moved to Lost (reason: ${reasonHuman}).`;

    try {
      // Capture before-state so the audit row carries a meaningful diff.
      const [beforeRow] = await sql<Array<{ id: number; status: string; lost_reason: string | null }>>`
        SELECT id, status, lost_reason
          FROM crm.enrolments
         WHERE submission_id = ${parent.id}
         LIMIT 1
      `;

      let rowsAffected = 0;
      await sql.begin(async (trx) => {
        await trx`SET LOCAL ROLE functions_writer`;
        const updateResult = await trx`
          UPDATE crm.enrolments
             SET status            = 'lost',
                 lost_reason       = ${lostReason!},
                 status_updated_at = now(),
                 updated_at        = now()
           WHERE submission_id = ${parent.id}
        `;
        rowsAffected = updateResult.count;
        // System-authored note so the provider sees a clear explanation in
        // the lead's notes log alongside the silent status flip. Only
        // written when the lead is actually routed to a provider — there's
        // no notes log to write to otherwise.
        if (parent.primary_routed_to) {
          await trx`
            INSERT INTO crm.lead_notes (
              submission_id, provider_id, provider_user_id,
              author_role, author_user_id, author_display_name, body
            ) VALUES (
              ${parent.id}, ${parent.primary_routed_to}, NULL,
              'system', NULL, 'Switchable', ${noteBody}
            )
          `;
        }
      });

      // Distinguish "UPDATE threw" (caught below) from "UPDATE ran but
      // matched 0 rows" — the latter is silent in postgres but means the
      // crm.enrolments row didn't exist (lead never landed in CRM). Either
      // way, sheet must NOT be told to mark this lead Lost.
      if (rowsAffected > 0) {
        flipSucceeded = true;
      } else {
        await persistSideEffectFailure(
          rawBody,
          `fastrack: UPDATE crm.enrolments matched 0 rows for submission_id=${parent.id} (no enrolment row exists). Sheet will receive fastrack notes but NOT Lost status.`,
          parent.id,
        );
      }

      // Audit trail. system surface so /admin/leads/[id] activity panel
      // shows the auto-flip alongside provider/admin actions. Best-effort:
      // failure here doesn't undo the UPDATE.
      if (beforeRow) {
        try {
          // Public-schema wrapper (migration 0147) over audit.log_system_action.
          // Works regardless of caller role context — future SET LOCAL ROLE
          // additions inside this code path won't silently drop audit rows.
          await sql`
            SELECT public.log_system_action_v1(
              'fastrack-receive',
              'mark_outcome_auto_dq',
              'crm.enrolments',
              ${String(beforeRow.id)},
              ${JSON.stringify({ status: beforeRow.status, lost_reason: beforeRow.lost_reason })}::jsonb,
              ${JSON.stringify({ status: "lost", lost_reason: lostReason })}::jsonb,
              ${JSON.stringify({ submission_id: parent.id, source: "fastrack-receive", reason: lostReason })}::jsonb
            )
          `;
        } catch (err) {
          console.warn(
            "fastrack: public.log_system_action_v1 failed (non-fatal):",
            describeError(err),
          );
        }
      }
    } catch (err) {
      // Non-fatal: child row already landed; surface the failure but keep
      // going. Sheet write is still valuable; owner sees the issue via
      // dead_letter / logs.
      console.error(
        "fastrack: enrolment status flip failed (non-fatal):",
        describeError(err),
      );
      await persistSideEffectFailure(
        rawBody,
        `fastrack: enrolment status flip failed for submission_id=${parent.id} reason=${lostReason}: ${describeError(err)}`,
        parent.id,
      );
    }
  }

  // Step 8.5: refresh Brevo card. The parent's fastracked_at was just
  // stamped in Step 6, and crm.enrolments.status may have just flipped to
  // 'lost' in Step 8. route-lead.ts pushes Brevo attributes only at lead-
  // insert time, so without this call the contact's SW_FASTRACK_COMPLETED
  // (and SW_ENROL_STATUS for the DQ paths) stay at their pre-fastrack
  // values forever. RPC is async via net.http_post, doesn't block.
  // See project memory: project_brevo_urls_dont_auto_refresh_on_post_insert.md
  try {
    await sql`
      SELECT crm.sync_leads_to_brevo(ARRAY[${parent.id}::bigint])
    `;
  } catch (err) {
    console.error(
      "fastrack: Brevo sync RPC failed (non-fatal):",
      describeError(err),
    );
  }

  // Step 8.6: u-fastrack-qualified transactional ack. Fires only when the
  // learner CLEARS the qualifying conditions on the fastrack form:
  //   cohort_confirmed === true   (they accept the cohort dates)
  //   l3_reconfirmed === false    (they have not self-reported an L3 mismatch)
  // The two DQ paths (cohort_decline / l3_mismatch_self_reported) stay silent
  // on this send by design — those learners are auto-DQ'd in Step 8 and get
  // their own communication via the existing flows.
  //
  // Idempotent via crm.email_log on (submission_id, 'u_fastrack_qualified').
  // Legal basis: contract — goes regardless of marketing_opt_in, because it's
  // an operational confirmation of an application step plus a named-rep
  // callback heads-up. Template reuses existing SW_PROVIDER_CONTACT_BEFORE/
  // PHONE/AFTER attribute composition for the named-rep + bold-phone block.
  //
  // Dormant until BREVO_TEMPLATE_U_FASTRACK_QUALIFIED env var is set —
  // sendTransactional returns skipped_missing_template silently.
  if (cohortConfirmed === true && l3Reconfirmed === false && parent.email) {
    const templateId = Number(Deno.env.get("BREVO_TEMPLATE_U_FASTRACK_QUALIFIED") ?? "0");
    if (templateId > 0) {
      const recipientName = [parent.first_name, parent.last_name]
        .filter(Boolean).join(" ") || undefined;
      try {
        await sendTransactional({
          sql,
          templateId,
          recipient: { email: parent.email, name: recipientName },
          // Brevo's transactional API rejects an empty params object with
          // 400 "params is blank". Pass FIRSTNAME/LASTNAME/SW_FUNDING_CATEGORY
          // even though the template renders from contact attributes — same
          // shape as email-u4-cron / email-stalled-cron so the call satisfies
          // Brevo's non-empty-params requirement.
          params: {
            FIRSTNAME: parent.first_name ?? "",
            LASTNAME: parent.last_name ?? "",
            SW_FUNDING_CATEGORY: parent.funding_category ?? "",
          },
          submissionId: parent.id,
          emailType: "u_fastrack_qualified",
          brand: "switchable",
          tags: ["fastrack", "qualify-ack"],
        });
      } catch (err) {
        console.error(
          "fastrack: u-fastrack-qualified send failed (non-fatal):",
          describeError(err),
        );
      }
    }

    // Step 8.7: SMS Trigger B (save-number on qualify-PASS). Sister to the
    // email above — same gate condition, fires once per submission via the
    // sendSms idempotency check on (submission_id, 'call_reminder_save_number').
    // Gates inside fireSaveNumberSms: funding gov/loan, phone present,
    // provider.sms_utility_enabled=true, regional rep phone resolves.
    // Best-effort; failures land in leads.dead_letter via sendSms's persist
    // path, the email above doesn't roll back.
    if (parent.primary_routed_to) {
      try {
        const [fullSubmission] = await sql<SubmissionRow[]>`
          SELECT ${sql.unsafe(SUBMISSION_FULL_COLUMNS)}
            FROM leads.submissions
           WHERE id = ${parent.id}
           LIMIT 1
        `;
        const [providerRow] = await sql<ProviderRow[]>`
          SELECT provider_id, company_name, contact_email, contact_name,
                 sheet_id, sheet_webhook_url, crm_webhook_url, cc_emails,
                 active, archived_at, auto_route_enabled,
                 trust_line, regions, portal_enabled, regional_contacts
            FROM crm.providers
           WHERE provider_id = ${parent.primary_routed_to}
           LIMIT 1
        `;
        if (fullSubmission && providerRow) {
          const smsOutcome = await fireSaveNumberSms({
            sql,
            submission: fullSubmission,
            provider: providerRow,
          });
          if (smsOutcome.kind === "skipped") {
            console.log(
              `fastrack: SMS save-number skipped for submission ${parent.id}: ${smsOutcome.reason}`,
            );
          }
        }
      } catch (err) {
        console.error(
          "fastrack: SMS save-number send failed (non-fatal):",
          describeError(err),
        );
      }
    }
  }

  // Step 9: sheet update via provider-sheet-appender-v2 in
  // update_by_submission_id mode. Best-effort; failures land in dead_letter.
  if (parent.primary_routed_to && SHEETS_APPEND_TOKEN) {
    const providerRows = await sql<Array<{
      sheet_webhook_url: string | null;
      company_name: string;
    }>>`
      SELECT sheet_webhook_url, company_name
        FROM crm.providers
       WHERE provider_id = ${parent.primary_routed_to}
       LIMIT 1
    `;
    const provider = providerRows[0];

    if (provider?.sheet_webhook_url) {
      const fastrackNotes = composeFastrackNotes({
        cohortConfirmed,
        transportHelp,
        docsReady,
        l3Reconfirmed,
        voice,
        l3MismatchFlag,
        earningsReconfirmed,
      });

      const sheetPayload: Record<string, unknown> = {
        token: SHEETS_APPEND_TOKEN,
        mode: "update_by_submission_id",
        submission_id: parent.id,
        fastracked: "yes",
        fastrack_notes: fastrackNotes,
      };
      // Sheet "Lost" write is gated on the DB flip succeeding. Without
      // this gate, a Step 8 failure (transaction throw, 0 rows matched)
      // leaves the sheet saying "Lost" while crm.enrolments stays
      // "open" — the divergence lead #375 hit.
      if (lostReason && flipSucceeded) {
        sheetPayload.status = "Lost";
        sheetPayload.lost_reason = lostReasonHumanText(lostReason);
      }

      try {
        const res = await fetch(provider.sheet_webhook_url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sheetPayload),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "<unreadable>");
          await persistSideEffectFailure(
            rawBody,
            `fastrack: appender HTTP ${res.status} for submission_id=${parent.id}: ${text.slice(0, 300)}`,
            parent.id,
          );
        } else {
          const respBody = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            error?: string;
            updates?: number;
          };
          if (respBody.ok === false) {
            await persistSideEffectFailure(
              rawBody,
              `fastrack: appender returned ok=false for submission_id=${parent.id}: ${respBody.error ?? "unknown"}`,
              parent.id,
            );
          } else if (typeof respBody.updates === "number" && respBody.updates === 0) {
            // ok=true but no cells updated — sheet probably missing the
            // Fastrack column headers. Surface so owner notices.
            await persistSideEffectFailure(
              rawBody,
              `fastrack: appender wrote 0 cells for submission_id=${parent.id} (sheet missing Fastrack headers?)`,
              parent.id,
            );
          }
        }
      } catch (err) {
        await persistSideEffectFailure(
          rawBody,
          `fastrack: appender fetch failed for submission_id=${parent.id}: ${describeError(err)}`,
          parent.id,
        );
      }
    }
  }

  // Step 10: notify provider's team when a clean fastrack lands.
  // Only fires on the eager-signal path — i.e. learner still qualifies
  // (no l3_mismatch, no cohort_decline). Auto-DQ paths already write a
  // system note + audit row; piling an email on top would be misleading.
  // Also requires parent.primary_routed_to (no routed provider = no team
  // to notify). PII-free: just the lead ID + a deep link.
  let notifySent = 0;
  let notifySkipped = 0;
  const cleanFastrack = cohortConfirmed === true && l3Reconfirmed === false;
  if (cleanFastrack && parent.primary_routed_to) {
    try {
      notifySent = await notifyProviderOfFastrack({
        submissionId: parent.id,
        fastrackSubmissionId: fastrackId,
        providerId: parent.primary_routed_to,
      });
    } catch (err) {
      console.error(
        "fastrack: provider notify failed (non-fatal):",
        describeError(err),
      );
      notifySkipped = 1;
      // Don't dead-letter — Brevo failures here aren't lead-critical.
    }
  }

  return json({
    status: "ok",
    fastrack_submission_id: fastrackId,
    parent_submission_id: parent.id,
    l3_mismatch_flag: l3MismatchFlag,
    cohort_decline_flag: cohortDeclineFlag,
    lost_reason: lostReason,
    notify_sent: notifySent,
    notify_skipped: notifySkipped,
  });
});

// Emails every active provider_user for the given provider with a PII-free
// "Lead #N has fast-tracked, eager signal" note + deep link to the portal
// lead page. Returns the number of successful sends.
async function notifyProviderOfFastrack(args: {
  submissionId: number;
  fastrackSubmissionId: number;
  providerId: string;
}): Promise<number> {
  const lockKey = `fastrack-provider-notify:${args.submissionId}`;
  await sql`SELECT pg_advisory_lock(hashtext(${lockKey}))`;
  try {
    const priorCleanRows = await sql<Array<{ id: number }>>`
      SELECT id
        FROM leads.fastrack_submissions
       WHERE parent_submission_id = ${args.submissionId}
         AND id < ${args.fastrackSubmissionId}
         AND cohort_confirmed IS TRUE
         AND l3_reconfirmed IS FALSE
       LIMIT 1
    `;
    if (priorCleanRows.length > 0) {
      console.log(
        `fastrack notify skipped for submission ${args.submissionId}: prior clean fastrack ${
          priorCleanRows[0].id
        }`,
      );
      return 0;
    }

    const recipients = await sql<
      Array<{
        contact_email: string;
        display_name: string | null;
      }>
    >`
    SELECT contact_email, display_name
      FROM crm.provider_users
     WHERE provider_id = ${args.providerId}
       AND status = 'active'
     ORDER BY id
  `;
    const seenRecipients = new Set<string>();
    const recipientObjs: Array<{ email: string; name?: string }> = [];
    for (const r of recipients) {
      if (!r.contact_email) continue;
      const emailKey = r.contact_email.trim().toLowerCase();
      if (!emailKey || seenRecipients.has(emailKey)) continue;
      seenRecipients.add(emailKey);
      recipientObjs.push({
        email: r.contact_email,
        name: r.display_name ?? r.contact_email,
      });
    }
    if (recipientObjs.length === 0) return 0;

    // The proxy on app.switchleads.co.uk rewrites /leads/<id> → /provider/leads/<id>
    // (same convention as route-lead.ts / the other provider notifications).
    const portalUrl =
      `https://app.switchleads.co.uk/leads/${args.submissionId}`;
    const subject =
      `Lead #${args.submissionId} just fast-tracked — eager signal`;
    const html = composeFastrackNotifyHtml({
      submissionId: args.submissionId,
      portalUrl,
    });

    // One email with the team CC'd (matches the normal lead notification), not an
    // individual send per person — so every recipient can see who else is on it.
    const result = await sendBrevoEmail({
      brand: "switchleads",
      to: [recipientObjs[0]],
      cc: recipientObjs.length > 1 ? recipientObjs.slice(1) : undefined,
      subject,
      htmlContent: html,
      tags: ["fastrack-notify-provider"],
    });
    if (!result.ok) {
      console.error(
        `fastrack notify Brevo send failed: ${result.error ?? "unknown"}`,
      );
      return 0;
    }
    return recipientObjs.length;
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext(${lockKey}))`;
  }
}

function composeFastrackNotifyHtml(args: {
  submissionId: number;
  portalUrl: string;
}): string {
  return `
<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0f172a; line-height: 1.5; padding: 16px; max-width: 560px;">
  <p>Hi,</p>
  <p>Lead <strong>#${args.submissionId}</strong> has just completed the fast-track form on their thank-you page.</p>
  <p>This is an eager signal: the learner confirmed their cohort, kept their qualifications consistent, and opted to move things along themselves. Worth a call sooner rather than later.</p>
  <p style="margin: 24px 0;">
    <a href="${args.portalUrl}" style="display: inline-block; padding: 10px 18px; background: #0f172a; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">
      Open the lead in your portal
    </a>
  </p>
  <p style="margin-top: 32px; color: #64748b;">Switchable</p>
</body></html>
  `.trim();
}

// -------- helpers --------

function composeFastrackNotes(args: {
  cohortConfirmed: boolean | null;
  transportHelp: boolean | null;
  docsReady: boolean | null;
  l3Reconfirmed: boolean | null;
  voice: string | null;
  l3MismatchFlag: boolean;
  earningsReconfirmed?: boolean | null;
}): string {
  const docsLine = args.docsReady === false ? "no ⚠ Docs gathering needed" : yn(args.docsReady);
  const l3Line = args.l3MismatchFlag ? "yes ⚠ MISMATCH" : yn(args.l3Reconfirmed);
  const parts = [
    `Cohort confirmed: ${yn(args.cohortConfirmed)}`,
    `Transport help: ${yn(args.transportHelp)}`,
    `Docs ready: ${docsLine}`,
    `L3 reconfirmed: ${l3Line}`,
  ];
  // AEB fastracks carry an earnings reconfirm instead of L3; surface it when
  // present. NULL on FCFJ → not appended, so FCFJ summaries are unchanged.
  if (args.earningsReconfirmed !== null && args.earningsReconfirmed !== undefined) {
    parts.push(`Earnings under £30k reconfirmed: ${yn(args.earningsReconfirmed)}`);
  }
  const tail = `Notes: ${args.voice ?? "—"}`;
  return `${parts.join(" | ")}\n${tail}`;
}

function lostReasonHumanText(reason: LostReason): string {
  if (reason === "l3_mismatch_self_reported") {
    return "L3 mismatch (self-reported on fastrack)";
  }
  return "Cohort decline (couldn't commit to start date)";
}

function yn(v: boolean | null | undefined): string {
  if (v === true) return "yes";
  if (v === false) return "no";
  return "—";
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

function toBool(v: unknown): boolean | null {
  if (v === true || v === "true" || v === "yes" || v === "on" || v === "1") return true;
  if (v === false || v === "false" || v === "no" || v === "off" || v === "0") return false;
  return null;
}

async function deadLetter(
  rawPayload: unknown,
  errorContext: string,
): Promise<Response> {
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        INSERT INTO leads.dead_letter (source, raw_payload, error_context)
        VALUES ('fastrack_form', ${sql.json((rawPayload ?? {}) as never)}, ${errorContext})
      `;
    });
  } catch (deadLetterErr) {
    console.error(
      "fastrack: dead_letter write failed:",
      describeError(deadLetterErr),
      "original error:",
      errorContext,
    );
  }
  return json({ status: "dead_letter", error: errorContext }, 200);
}

async function persistSideEffectFailure(
  rawPayload: unknown,
  errorContext: string,
  submissionId: number,
): Promise<void> {
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        INSERT INTO leads.dead_letter (source, raw_payload, error_context, replay_submission_id)
        VALUES ('fastrack_side_effect', ${sql.json((rawPayload ?? {}) as never)}, ${errorContext}, ${submissionId})
      `;
    });
  } catch (err) {
    console.error(
      "fastrack: side-effect dead_letter write failed:",
      describeError(err),
      "original:",
      errorContext,
    );
  }
}

function describeError(err: unknown): string {
  if (!err) return "unknown error (falsy)";
  if (err instanceof Error) {
    const pgErr = err as Error & {
      code?: string;
      detail?: string;
      hint?: string;
      severity?: string;
    };
    const parts: string[] = [];
    if (pgErr.code) parts.push(`code=${pgErr.code}`);
    if (pgErr.severity) parts.push(`severity=${pgErr.severity}`);
    if (err.message) parts.push(`message=${err.message}`);
    if (pgErr.detail) parts.push(`detail=${pgErr.detail}`);
    if (pgErr.hint) parts.push(`hint=${pgErr.hint}`);
    if (parts.length === 0) parts.push(`name=${err.name}`);
    return parts.join(" | ");
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
