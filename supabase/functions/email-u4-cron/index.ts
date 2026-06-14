// Edge Function: email-u4-cron
//
// Daily cron at 09:30 UTC (30 min after stalled-cron so the day's order is
// stable). Scans for leads where the enrolment outcome has flipped to
// enrolled / presumed_enrolled and the U4 enrolment-confirmation email has
// not yet been sent via the new transactional path. For each, fires the
// U4 email through sendTransactional.
//
// Phase 2b of the email platform rearchitecture (spec at
// platform/docs/email-platform-rearchitecture-spec.md). Runs in shadow mode
// alongside the existing list-add automation until BREVO_SHADOW_MODE=false.
//
// Lifecycle gate: only leads with a u1_funded/u1_self row in crm.email_log
// are considered. That excludes pre-Phase-2 leads from being re-U4'd on top
// of whatever the old automation already did to them.
//
// Why a scheduled job over a DB trigger: a synchronous trigger calling Brevo
// would block writers of crm.enrolments if Brevo is slow. ~24h max latency
// on U4 is acceptable; spec amendment 2026-05-05 locked this in.
//
// Auth: x-audit-key / AUDIT_SHARED_SECRET. Deploy with --no-verify-jwt.

import postgres from "npm:postgres@3";
import { sendTransactional, addBrevoContactToList } from "../_shared/brevo.ts";

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

const THROTTLE_MS = 250;

interface CandidateRow {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  funding_category: string | null;
}

interface SendOutcome {
  submission_id: number;
  status: string;
  error?: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
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

  // Candidate query.
  //
  // Filters:
  //   1. enrolments row with status enrolled/presumed_enrolled
  //   2. submission not DQ, not archived
  //   3. has a u1 transactional row in email_log (Phase 2 gate)
  //   4. has NOT been U4'd before via the new path
  let candidates: CandidateRow[];
  try {
    candidates = await sql<CandidateRow[]>`
      SELECT s.id,
             s.email,
             s.first_name,
             s.last_name,
             s.funding_category
        FROM crm.enrolments e
        JOIN leads.submissions s ON s.id = e.submission_id
       WHERE e.status IN ('enrolled','presumed_enrolled')
         AND s.is_dq = false
         AND s.archived_at IS NULL
         AND s.email IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM crm.email_log el
            WHERE el.submission_id = s.id
              AND el.email_type IN ('u1_funded','u1_self')
              AND el.status IN ('sent','delivered','opened','clicked')
         )
         AND NOT EXISTS (
           SELECT 1 FROM crm.email_log el
            WHERE el.submission_id = s.id
              AND el.email_type IN ('u4_funded','u4_self')
              AND el.status IN ('queued','sent','delivered','opened','clicked')
         )
       ORDER BY s.id
       LIMIT 500
    `;
  } catch (err) {
    console.error("candidate query failed:", String(err));
    return json({ error: `candidate query: ${String(err)}` }, 500);
  }

  const fundedTemplateId = parseEnvInt("BREVO_TEMPLATE_U4_FUNDED");
  const selfTemplateId = parseEnvInt("BREVO_TEMPLATE_U4_SELF");
  const missingTemplate = fundedTemplateId == null || selfTemplateId == null;

  const outcomes: SendOutcome[] = [];
  let sentCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    if (i > 0) await sleep(THROTTLE_MS);
    const c = candidates[i];

    if (!c.funding_category) {
      outcomes.push({ submission_id: c.id, status: "skipped_no_funding_category" });
      skippedCount++;
      continue;
    }

    const isFunded = c.funding_category === "gov" || c.funding_category === "loan";
    const templateId = isFunded ? fundedTemplateId : selfTemplateId;
    const emailType: "u4_funded" | "u4_self" = isFunded ? "u4_funded" : "u4_self";

    if (templateId == null) {
      outcomes.push({ submission_id: c.id, status: "skipped_missing_template" });
      skippedCount++;
      continue;
    }

    const recipientName = [c.first_name, c.last_name].filter(Boolean).join(" ") || undefined;

    const result = await sendTransactional({
      sql,
      templateId,
      recipient: { email: c.email, name: recipientName },
      params: {
        FIRSTNAME: c.first_name ?? "",
        LASTNAME: c.last_name ?? "",
        SW_FUNDING_CATEGORY: c.funding_category,
      },
      submissionId: c.id,
      emailType,
      brand: "switchable",
      tags: ["u4", emailType, "cron"],
    });

    if (result.ok && result.status === "sent") {
      sentCount++;
      outcomes.push({ submission_id: c.id, status: "sent" });
    } else if (result.status === "skipped_duplicate") {
      skippedCount++;
      outcomes.push({ submission_id: c.id, status: "skipped_duplicate" });
    } else {
      failedCount++;
      outcomes.push({ submission_id: c.id, status: "failed", error: result.error });
    }
  }

  // Alumni list graduation (item 4, 2026-06-14). Once a learner enrols they
  // belong on the "enrolled / alumni" list. Brevo already moves nurtured
  // prospects to the newsletter list on its own; this just adds enrolled
  // contacts to the alumni list. Add-only — no removal needed (per owner).
  // Runs as a daily "ensure every enrolled contact is on the list" sweep
  // rather than a one-shot, so the 7 contacts who enrolled before this shipped
  // get picked up too. addBrevoContactToList is idempotent (re-adding is a
  // no-op), which keeps this safe to run every day. At pilot scale (~27
  // enrolled) the redundant adds are negligible; if enrolled volume grows
  // large, switch to a tracked flag so we only add new graduates.
  let alumniAdded = 0;
  let alumniFailed = 0;
  const alumniListId = parseEnvInt("BREVO_LIST_ID_SWITCHABLE_ALUMNI");
  if (alumniListId != null) {
    let enrolled: Array<{ email: string }> = [];
    try {
      enrolled = await sql<Array<{ email: string }>>`
        SELECT DISTINCT s.email
          FROM crm.enrolments e
          JOIN leads.submissions s ON s.id = e.submission_id
         WHERE e.status IN ('enrolled','presumed_enrolled')
           AND s.is_dq = false
           AND s.archived_at IS NULL
           AND s.email IS NOT NULL
      `;
    } catch (err) {
      console.error("alumni: enrolled query failed:", String(err));
    }
    for (let i = 0; i < enrolled.length; i++) {
      if (i > 0) await sleep(THROTTLE_MS);
      const r = await addBrevoContactToList({ email: enrolled[i].email, listId: alumniListId });
      if (r.ok) alumniAdded++;
      else { alumniFailed++; console.error(`alumni: add ${enrolled[i].email} -> list ${alumniListId} failed: ${r.error}`); }
    }
  }

  return json({
    candidates: candidates.length,
    sent: sentCount,
    skipped: skippedCount,
    failed: failedCount,
    missing_template_env: missingTemplate,
    alumni_list_id: alumniListId,
    alumni_added: alumniAdded,
    alumni_failed: alumniFailed,
    outcomes,
  }, 200);
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
