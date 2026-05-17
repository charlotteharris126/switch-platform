// Edge Function: backfill-client-nonce
//
// Stamps a fresh UUID into leads.submissions.client_nonce for funded
// leads who don't have one yet AND are still in-funnel (not enrolled,
// not presumed_enrolled). Lets the operator copy a per-lead fastrack
// URL from /admin/leads/[id] and paste it into a hand-written email,
// even for pre-2026-05-07 funded submissions that pre-date migration
// 0087 (when client_nonce capture went live).
//
// Auth: x-audit-key matched against AUDIT_SHARED_SECRET in vault.
// Body: { "apply": boolean }
//
// Audience filter:
//   - funding_category IN ('gov', 'loan')  (funded routes)
//   - client_nonce IS NULL                  (not yet stamped)
//   - is_dq IS NOT TRUE                     (DQ leads never enter the
//                                             provider funnel)
//   - submission_id NOT IN (SELECT submission_id FROM crm.enrolments
//      WHERE status IN ('enrolled', 'presumed_enrolled'))
//     (excludes closed-funnel leads; everything else — open, attempting,
//     meeting_booked, lost, cannot_reach — is in scope)
//
// One-shot. Idempotent: re-running is a no-op once every row in the
// audience has a nonce. New funded submissions get their nonce at
// form-submit time via the existing route-lead.ts pipeline.
//
// Note on SW_FASTRACK_URL Brevo attribute: this backfill writes to the
// DB only. To propagate the new nonces to existing Brevo contacts'
// SW_FASTRACK_URL attribute, re-run the 024 backfill from the same
// admin page afterwards.

import postgres from "npm:postgres@3";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL not set");
}

const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 20, prepare: false });

interface AudienceRow {
  id: number;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  funding_category: string | null;
  submitted_at: string;
}

interface UpdatedRow extends AudienceRow {
  new_nonce: string;
}

interface SpotCheck {
  id: number;
  email: string | null;
  full_name: string;
  funding_category: string | null;
  submitted_at: string;
  new_nonce: string;
  fastrack_url: string;
}

interface RunSummary {
  mode: "dry_run" | "apply";
  audience_size: number;
  mutated: number;
  spot_checks: SpotCheck[];
}

async function getAuditSharedSecret(): Promise<string> {
  const rows = await sql<Array<{ secret: string }>>`
    SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
  `;
  const secret = rows[0]?.secret;
  if (!secret) throw new Error("AUDIT_SHARED_SECRET not in vault");
  return secret;
}

async function loadAudience(): Promise<AudienceRow[]> {
  return await sql<AudienceRow[]>`
    SELECT s.id, s.email, s.first_name, s.last_name,
           s.funding_category, s.submitted_at
    FROM leads.submissions s
    WHERE s.funding_category IN ('gov', 'loan')
      AND s.client_nonce IS NULL
      AND s.is_dq IS NOT TRUE
      AND NOT EXISTS (
        SELECT 1 FROM crm.enrolments e
        WHERE e.submission_id = s.id
          AND e.status IN ('enrolled', 'presumed_enrolled')
      )
    ORDER BY s.submitted_at ASC
  `;
}

async function applyBackfill(): Promise<UpdatedRow[]> {
  // Single atomic UPDATE with the same filter as the audience query.
  // gen_random_uuid() runs once per matching row, so every row gets
  // a unique nonce in one round-trip.
  return await sql<UpdatedRow[]>`
    UPDATE leads.submissions s
       SET client_nonce = gen_random_uuid()
     WHERE s.funding_category IN ('gov', 'loan')
       AND s.client_nonce IS NULL
       AND s.is_dq IS NOT TRUE
       AND NOT EXISTS (
         SELECT 1 FROM crm.enrolments e
         WHERE e.submission_id = s.id
           AND e.status IN ('enrolled', 'presumed_enrolled')
       )
    RETURNING s.id, s.email, s.first_name, s.last_name,
              s.funding_category, s.submitted_at,
              s.client_nonce::text AS new_nonce
  `;
}

function fastrackUrl(nonce: string): string {
  return `https://switchable.org.uk/funded/thank-you/?ref=${encodeURIComponent(nonce)}`;
}

function fullName(r: AudienceRow): string {
  return [r.first_name, r.last_name].filter(Boolean).join(" ") || "(no name)";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function run(apply: boolean): Promise<RunSummary> {
  if (!apply) {
    const audience = await loadAudience();
    const spot: SpotCheck[] = audience.slice(0, 3).map((r) => ({
      id: r.id,
      email: r.email,
      full_name: fullName(r),
      funding_category: r.funding_category,
      submitted_at: r.submitted_at,
      new_nonce: "(dry-run, no nonce generated)",
      fastrack_url: "(would be generated on apply)",
    }));
    return {
      mode: "dry_run",
      audience_size: audience.length,
      mutated: 0,
      spot_checks: spot,
    };
  }

  const updated = await applyBackfill();

  // Brevo sync. Stamping a client_nonce changes SW_FASTRACK_URL from empty
  // to a real link — but Brevo only learns about it if something tells the
  // Brevo contact card. Without this call, those contacts' Brevo records
  // keep the empty fastrack URL and stay drifted until the next URL-backfill
  // sweep runs. Async via net.http_post inside the RPC, so it doesn't slow
  // this function down or block the caller.
  if (updated.length > 0) {
    try {
      const ids = updated.map((r) => r.id);
      await sql`
        SELECT crm.sync_leads_to_brevo(${ids}::bigint[])
      `;
    } catch (err) {
      console.error(
        "backfill-client-nonce: Brevo sync RPC failed (non-fatal):",
        String(err),
      );
    }
  }

  const spot: SpotCheck[] = updated.slice(0, 3).map((r) => ({
    id: r.id,
    email: r.email,
    full_name: fullName(r),
    funding_category: r.funding_category,
    submitted_at: r.submitted_at,
    new_nonce: r.new_nonce,
    fastrack_url: fastrackUrl(r.new_nonce),
  }));
  return {
    mode: "apply",
    audience_size: updated.length,
    mutated: updated.length,
    spot_checks: spot,
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let expected: string;
  try {
    expected = await getAuditSharedSecret();
  } catch (err) {
    console.error("vault secret fetch failed:", String(err));
    return json({ ok: false, error: "AUDIT_SHARED_SECRET not retrievable from vault" }, 500);
  }
  const provided = req.headers.get("x-audit-key");
  if (!provided || provided !== expected) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let body: { apply?: unknown };
  try {
    body = await req.json() as { apply?: unknown };
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const apply = body.apply === true;

  try {
    const summary = await run(apply);
    return json({ ok: true, ...summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("backfill failed:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});
