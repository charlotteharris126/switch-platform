// Edge Function: admin-brevo-chase
//
// Bulk-adds Switchable contacts to the "Provider tried no answer" internal
// Brevo list, which triggers the SF2 chaser automation. Auto-removal at
// the end of SF2 means re-adding fires the chaser fresh. Owner triggers
// this from /admin/leads when a provider reports they couldn't reach
// the learner.
//
// Phase 2b of the email platform rearchitecture (spec at
// platform/docs/email-platform-rearchitecture-spec.md): in addition to the
// legacy list-add (which keeps firing while BREVO_SHADOW_MODE is on), the
// function also calls sendTransactional with the chaser template and
// forceResend=true. The chaser is the only email_type that bypasses
// per-submission idempotency — every chaser send is a deliberate re-fire.
// Branches on the submission's funding_category to pick the funded vs self
// chaser template. Skips the transactional path silently per-email if the
// per-funding template env var is unset (legacy list-add still runs).
//
// Auth: same x-audit-key / AUDIT_SHARED_SECRET pattern as
// admin-brevo-resync. config.toml verify_jwt=false.
//
// Body: {
//   "emails": ["a@b.com", ...],
//   "submissionIds": [123, ...]   // for dead_letter context AND transactional send
// }
//
// Failure handling:
//   - Brevo 4xx/5xx → leads.dead_letter row per email, return per-email
//     status to caller. Doesn't unwind the DB stamp inside
//     crm.fire_provider_chaser — owner's intent IS recorded; if Brevo
//     rejected it, the dead_letter shows the failure and the owner can
//     retry. (Better than an all-or-nothing rollback that loses the
//     audit trail of what was attempted.)

import postgres from "npm:postgres@3";
import { addBrevoContactToList, sendTransactional } from "../_shared/brevo.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL is not set.");
}

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

interface ChaseResult {
  email: string;
  submissionId: number | null;
  status: "ok" | "error" | "skipped";
  reason?: string;
  /** Phase 2b: status of the parallel transactional send. */
  transactional?: "sent" | "skipped" | "failed";
  transactionalError?: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const providedKey = req.headers.get("x-audit-key");
  if (!providedKey) return new Response("Unauthorized", { status: 401 });

  let expectedKey: string;
  try {
    const [row] = await sql<Array<{ secret: string }>>`
      SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
    `;
    expectedKey = row?.secret ?? "";
    if (!expectedKey) throw new Error("AUDIT_SHARED_SECRET not in vault");
  } catch (err) {
    console.error("vault secret fetch failed:", String(err));
    return json({ error: "AUDIT_SHARED_SECRET not retrievable from vault" }, 500);
  }
  if (providedKey !== expectedKey) {
    return new Response("Unauthorized", { status: 401 });
  }

  const listIdRaw = Deno.env.get("BREVO_LIST_ID_PROVIDER_TRIED_NO_ANSWER");
  const listId = listIdRaw ? Number(listIdRaw) : NaN;
  if (!Number.isFinite(listId) || listId <= 0) {
    return json({ error: "BREVO_LIST_ID_PROVIDER_TRIED_NO_ANSWER not set or invalid" }, 500);
  }

  let body: { emails?: unknown; submissionIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const emails = Array.isArray(body.emails) ? body.emails : null;
  if (!emails || emails.length === 0) {
    return json({ error: "emails (non-empty array of strings) required" }, 400);
  }
  const stringEmails = emails.filter((v): v is string => typeof v === "string" && v.length > 0);
  const submissionIds = Array.isArray(body.submissionIds) ? body.submissionIds : [];

  // Throttle 250ms between calls — same posture as admin-brevo-resync; Brevo
  // rate-limits the contacts API around ~7-10 calls/sec depending on tier.
  const THROTTLE_MS = 250;
  const results: ChaseResult[] = [];

  // Phase 2b: per-funded-route chaser templates. Either may be missing;
  // sends to that funding route silently skip the transactional path.
  const chaserTemplateFundedId = parseEnvInt("BREVO_TEMPLATE_CHASER_FUNDED");
  const chaserTemplateSelfId = parseEnvInt("BREVO_TEMPLATE_CHASER_SELF");

  for (let i = 0; i < stringEmails.length; i++) {
    if (i > 0) await sleep(THROTTLE_MS);
    const email = stringEmails[i];
    const submissionId = typeof submissionIds[i] === "number" ? (submissionIds[i] as number) : null;

    // 1. Legacy list-add (still runs while shadow mode is on).
    // Brevo returns a 400 with code=invalid_parameter "Contact already in list
    // and/or does not exist" when the contact is already on the list (or has
    // been hard-deleted via GDPR erasure). Both cases are no-ops — the legacy
    // list-add has nothing to do. Treat as skipped, not error; don't pollute
    // dead_letter. The transactional send below is the real signal.
    const r = await addBrevoContactToList({ email, listId });
    let listAddStatus: ChaseResult["status"] = "ok";
    let listAddReason: string | undefined;
    if (!r.ok) {
      const errStr = r.error ?? "unknown";
      const isAlreadyInList = /already in list/i.test(errStr);
      if (isAlreadyInList) {
        listAddStatus = "skipped";
        listAddReason = "already_in_list";
      } else {
        listAddStatus = "error";
        listAddReason = errStr;
        try {
          await sql`
            INSERT INTO leads.dead_letter (source, raw_payload, error_context, received_at)
            VALUES (
              'edge_function_brevo_chase',
              ${sql.json({ email, submission_id: submissionId, list_id: listId })},
              ${`Brevo chaser list-add failed: ${errStr}`},
              now()
            )
          `;
        } catch (dlErr) {
          console.error("dead_letter write failed:", String(dlErr));
        }
      }
    }

    // 2. New transactional send (Phase 2b). Skips silently when:
    //   - submissionId not provided by caller (can't write a per-submission email_log row)
    //   - submission has no funding_category (can't pick funded vs self template)
    //   - the relevant per-funded-route template env var is not set
    let transactional: ChaseResult["transactional"];
    let transactionalError: string | undefined;
    if (submissionId !== null) {
      // Resolve first name + funding category for template params + branching.
      let first_name: string | null = null;
      let last_name: string | null = null;
      let funding_category: string | null = null;
      try {
        const [row] = await sql<Array<{ first_name: string | null; last_name: string | null; funding_category: string | null }>>`
          SELECT first_name, last_name, funding_category
            FROM leads.submissions
           WHERE id = ${submissionId}
        `;
        first_name = row?.first_name ?? null;
        last_name = row?.last_name ?? null;
        funding_category = row?.funding_category ?? null;
      } catch (err) {
        console.error(`submission ${submissionId} lookup failed:`, String(err));
      }

      if (!funding_category) {
        transactional = "skipped";
      } else {
        const isFunded = funding_category === "gov" || funding_category === "loan";
        const templateId = isFunded ? chaserTemplateFundedId : chaserTemplateSelfId;
        const emailType: "chaser_funded" | "chaser_self" = isFunded ? "chaser_funded" : "chaser_self";

        if (templateId === null) {
          transactional = "skipped";
        } else {
          const recipientName = [first_name, last_name].filter(Boolean).join(" ") || undefined;
          const sendResult = await sendTransactional({
            sql,
            templateId,
            recipient: { email, name: recipientName },
            params: {
              FIRSTNAME: first_name ?? "",
              LASTNAME: last_name ?? "",
              SW_FUNDING_CATEGORY: funding_category,
            },
            submissionId,
            emailType,
            brand: "switchable",
            tags: ["chaser", emailType, "admin-brevo-chase"],
            forceResend: true,
          });

          if (sendResult.ok && sendResult.status === "sent") {
            transactional = "sent";
          } else if (
            sendResult.status === "skipped_duplicate" ||
            sendResult.status === "skipped_missing_template"
          ) {
            transactional = "skipped";
          } else {
            transactional = "failed";
            transactionalError = sendResult.error;
          }
        }
      }
    } else {
      transactional = "skipped";
    }

    results.push({
      email,
      submissionId,
      status: listAddStatus,
      reason: listAddReason,
      transactional,
      transactionalError,
    });
  }

  return json({ results }, 200);
});

function parseEnvInt(name: string): number | null {
  const raw = Deno.env.get(name);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
