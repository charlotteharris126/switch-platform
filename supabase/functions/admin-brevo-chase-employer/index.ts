// Edge Function: admin-brevo-chase-employer
//
// Sends the S4B employer chaser to the contact on an employer_apprenticeship
// submission. Called from crm.fire_employer_chaser via pg_net when
// markOutcomeAction lands a chaser-triggering status (attempt_1/2/3_no_answer
// or cannot_reach) on an employer lead.
//
// Sibling of admin-brevo-chase (which is the learner / funded path). Kept
// as a separate function because:
//   - No legacy SF2 Brevo list-add to fire (employer side is transactional
//     only)
//   - Params shape is employer-specific (FIRSTNAME / COMPANY / STANDARD /
//     PROVIDER_NAME / SUBMISSION_ID), not funded/self learner shape
//   - Template branching keyed on funding_category doesn't apply
//
// Auth: same x-audit-key / AUDIT_SHARED_SECRET pattern as admin-brevo-chase
// (config.toml verify_jwt=false).
//
// Body: {
//   "submissionIds": [123, ...]
// }
//
// Per-submission behaviour:
//   - Looks up the submission row (first_name / last_name / email /
//     company_name / standards_interested / primary_routed_to)
//   - Resolves provider name from crm.providers (joined via primary_routed_to)
//   - sendTransactional with templateId from BREVO_TEMPLATE_S4B_EMPLOYER_CHASER,
//     emailType='s4b_employer_chaser', forceResend=true (mirrors learner
//     chaser: each fire is deliberate, idempotency would block re-attempts)
//   - On failure: leads.dead_letter row with source='edge_function_brevo_chase_employer'
//
// Skips silently per-submission when:
//   - BREVO_TEMPLATE_S4B_EMPLOYER_CHASER env var unset
//   - submission has no email
//   - submission lead_type !== 'employer_apprenticeship' (defence-in-depth;
//     the RPC already filters)

import postgres from "npm:postgres@3";
import { sendTransactional } from "../_shared/brevo.ts";

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
  submissionId: number;
  status: "sent" | "skipped" | "failed";
  reason?: string;
  error?: string;
}

interface EmployerRow {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company_name: string | null;
  standards_interested: string | null;
  lead_type: string | null;
  primary_routed_to: string | null;
  provider_name: string | null;
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const templateIdRaw = Deno.env.get("BREVO_TEMPLATE_S4B_EMPLOYER_CHASER");
  const templateId = templateIdRaw ? Number(templateIdRaw) : NaN;
  if (!Number.isFinite(templateId) || templateId <= 0) {
    return json({ error: "BREVO_TEMPLATE_S4B_EMPLOYER_CHASER not set or invalid" }, 500);
  }

  // Duplicate-send guard window (minutes). Mirrors the learner chaser and the
  // SMS 24h cooldown — collapses near-simultaneous re-fires for the same lead
  // while allowing a deliberate re-chase a day later. Env-tunable.
  const chaserWindowRaw = Deno.env.get("CHASER_RESEND_WINDOW_MINUTES");
  const resendWindowMinutes = chaserWindowRaw && Number.isFinite(Number(chaserWindowRaw))
    ? Number(chaserWindowRaw)
    : 1440;

  let body: { submissionIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const submissionIds = Array.isArray(body.submissionIds)
    ? body.submissionIds.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    : [];
  if (submissionIds.length === 0) {
    return json({ error: "submissionIds (non-empty array of numbers) required" }, 400);
  }

  const THROTTLE_MS = 250;
  const results: ChaseResult[] = [];

  for (let i = 0; i < submissionIds.length; i++) {
    if (i > 0) await sleep(THROTTLE_MS);
    const submissionId = submissionIds[i];

    let row: EmployerRow | undefined;
    try {
      const rows = await sql<Array<EmployerRow>>`
        SELECT
          s.id,
          s.first_name,
          s.last_name,
          s.email,
          s.company_name,
          s.standards_interested,
          s.lead_type,
          s.primary_routed_to,
          p.company_name AS provider_name
        FROM leads.submissions s
        LEFT JOIN crm.providers p ON p.provider_id = s.primary_routed_to
        WHERE s.id = ${submissionId}
      `;
      row = rows[0];
    } catch (err) {
      console.error(`submission ${submissionId} lookup failed:`, String(err));
      results.push({ submissionId, status: "failed", error: `lookup: ${String(err)}` });
      continue;
    }

    if (!row) {
      results.push({ submissionId, status: "skipped", reason: "not found" });
      continue;
    }

    if (row.lead_type !== "employer_apprenticeship") {
      results.push({ submissionId, status: "skipped", reason: "not an employer lead" });
      continue;
    }

    if (!row.email) {
      results.push({ submissionId, status: "skipped", reason: "no email" });
      continue;
    }

    const recipientName =
      [row.first_name, row.last_name].filter(Boolean).join(" ") || row.email;

    const sendResult = await sendTransactional({
      sql,
      templateId,
      recipient: { email: row.email, name: recipientName },
      params: {
        FIRSTNAME: row.first_name ?? "",
        LASTNAME: row.last_name ?? "",
        COMPANY: row.company_name ?? "",
        STANDARD: row.standards_interested ?? "",
        PROVIDER_NAME: row.provider_name ?? "",
        SUBMISSION_ID: row.id,
      },
      submissionId: row.id,
      emailType: "s4b_employer_chaser",
      brand: "switchable",
      tags: ["chaser", "s4b_employer_chaser", "admin-brevo-chase-employer"],
      forceResend: true,
      resendWindowMinutes,
    });

    if (sendResult.ok && sendResult.status === "sent") {
      results.push({ submissionId, status: "sent" });
    } else if (
      sendResult.status === "skipped_duplicate"
      || sendResult.status === "skipped_missing_template"
    ) {
      results.push({ submissionId, status: "skipped", reason: sendResult.status });
    } else {
      try {
        await sql`
          INSERT INTO leads.dead_letter (source, raw_payload, error_context, received_at)
          VALUES (
            'edge_function_brevo_chase_employer',
            ${sql.json({ submission_id: row.id, email: row.email })},
            ${`employer chaser send failed: ${sendResult.error ?? "unknown"}`},
            now()
          )
        `;
      } catch (dlErr) {
        console.error("dead_letter write failed:", String(dlErr));
      }
      results.push({ submissionId, status: "failed", error: sendResult.error });
    }
  }

  return json({ results }, 200);
});
