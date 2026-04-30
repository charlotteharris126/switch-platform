// Edge Function: admin-brevo-chase
//
// Bulk-adds Switchable contacts to the "Provider tried no answer" internal
// Brevo list, which triggers the SF2 chaser automation. Auto-removal at
// the end of SF2 means re-adding fires the chaser fresh. Owner triggers
// this from /admin/leads when a provider reports they couldn't reach
// the learner.
//
// Auth: same x-audit-key / AUDIT_SHARED_SECRET pattern as
// admin-brevo-resync. config.toml verify_jwt=false.
//
// Body: {
//   "emails": ["a@b.com", ...],
//   "submissionIds": [123, ...]   // for dead_letter context only
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
import { addBrevoContactToList } from "../_shared/brevo.ts";

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

  for (let i = 0; i < stringEmails.length; i++) {
    if (i > 0) await sleep(THROTTLE_MS);
    const email = stringEmails[i];
    const submissionId = typeof submissionIds[i] === "number" ? (submissionIds[i] as number) : null;
    const r = await addBrevoContactToList({ email, listId });
    if (r.ok) {
      results.push({ email, submissionId, status: "ok" });
    } else {
      try {
        await sql`
          INSERT INTO leads.dead_letter (source, raw_payload, error_context, received_at)
          VALUES (
            'edge_function_brevo_chase',
            ${sql.json({ email, submission_id: submissionId, list_id: listId })},
            ${`Brevo chaser list-add failed: ${r.error ?? "unknown"}`},
            now()
          )
        `;
      } catch (dlErr) {
        console.error("dead_letter write failed:", String(dlErr));
      }
      results.push({
        email,
        submissionId,
        status: "error",
        reason: r.error ?? "unknown",
      });
    }
  }

  return json({ results }, 200);
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
