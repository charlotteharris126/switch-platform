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
  }>>`
    SELECT id, prior_level_3_or_higher, primary_routed_to, email
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
  const voiceRaw = firstString(data.voice_of_learner_intro);
  const voice = voiceRaw
    ? voiceRaw.trim().slice(0, VOICE_OF_LEARNER_MAX_LEN)
    : null;
  const termsAccepted = toBool(data.terms_accepted) ?? false;
  const marketingOptIn = toBool(data.marketing_opt_in) ?? false;

  let fastrackId: number;
  try {
    fastrackId = await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
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
          ${voice},
          ${termsAccepted},
          ${marketingOptIn},
          ${trx.json(rawBody as never)},
          ${firstString(body.user_agent, data.user_agent) ?? null}
        )
        RETURNING id
      `;
      return Number(inserted[0].id);
    });
  } catch (err) {
    return await deadLetter(
      rawBody,
      `fastrack: insert failed: ${describeError(err)}`,
    );
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

  if (lostReason) {
    try {
      await sql.begin(async (trx) => {
        await trx`SET LOCAL ROLE functions_writer`;
        await trx`
          UPDATE crm.enrolments
             SET status            = 'lost',
                 lost_reason       = ${lostReason!},
                 status_updated_at = now(),
                 updated_at        = now()
           WHERE submission_id = ${parent.id}
        `;
      });
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
      });

      const sheetPayload: Record<string, unknown> = {
        token: SHEETS_APPEND_TOKEN,
        mode: "update_by_submission_id",
        submission_id: parent.id,
        fastracked: "yes",
        fastrack_notes: fastrackNotes,
      };
      if (lostReason) {
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

  return json({
    status: "ok",
    fastrack_submission_id: fastrackId,
    parent_submission_id: parent.id,
    l3_mismatch_flag: l3MismatchFlag,
    cohort_decline_flag: cohortDeclineFlag,
    lost_reason: lostReason,
  });
});

// -------- helpers --------

function composeFastrackNotes(args: {
  cohortConfirmed: boolean | null;
  transportHelp: boolean | null;
  docsReady: boolean | null;
  l3Reconfirmed: boolean | null;
  voice: string | null;
  l3MismatchFlag: boolean;
}): string {
  const docsLine = args.docsReady === false ? "no ⚠ Docs gathering needed" : yn(args.docsReady);
  const l3Line = args.l3MismatchFlag ? "yes ⚠ MISMATCH" : yn(args.l3Reconfirmed);
  const head = [
    `Cohort confirmed: ${yn(args.cohortConfirmed)}`,
    `Transport help: ${yn(args.transportHelp)}`,
    `Docs ready: ${docsLine}`,
    `L3 reconfirmed: ${l3Line}`,
  ].join(" | ");
  const tail = `Notes: ${args.voice ?? "—"}`;
  return `${head}\n${tail}`;
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
