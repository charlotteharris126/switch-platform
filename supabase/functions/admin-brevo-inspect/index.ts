// Edge Function: admin-brevo-inspect
//
// Read-only debug endpoint. GETs a contact from Brevo's API by email and
// returns the raw response. Used to verify what Brevo has actually stored
// for a contact (vs what the dashboard renders) when an upsert "succeeds"
// but attributes don't appear to land.
//
// Auth: same x-audit-key / AUDIT_SHARED_SECRET pattern as
// admin-brevo-resync. No DB writes, no Brevo writes — read only.
//
// Body: { "email": "lunamel.mejia@gmail.com" }
// Response: { "status": 200|404|..., "contact": <raw Brevo response object> }
//
// config.toml has verify_jwt=false; deploy with --no-verify-jwt for stickiness.

import postgres from "npm:postgres@3";

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

const BREVO_CONTACTS_ENDPOINT = "https://api.brevo.com/v3/contacts";

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Auth — same pattern as admin-brevo-resync
  const providedKey = req.headers.get("x-audit-key");
  if (!providedKey) {
    return new Response("Unauthorized", { status: 401 });
  }
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

  let body: { email?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email) {
    return json({ error: "email (string) required" }, 400);
  }

  const apiKey = Deno.env.get("BREVO_API_KEY");
  if (!apiKey) return json({ error: "BREVO_API_KEY not set" }, 500);

  const url = `${BREVO_CONTACTS_ENDPOINT}/${encodeURIComponent(email)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        "api-key": apiKey,
        "accept": "application/json",
      },
    });
  } catch (err) {
    return json({ error: `fetch failed: ${String(err)}` }, 500);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  return json({ status: res.status, contact: payload }, 200);
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
