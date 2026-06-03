// Edge Function: labs-event
// Receives Switchable Labs funnel events directly from the browser and inserts
// one row into labs.events. Events: run (results seen), unlock_intent (£17 click),
// signup (email left). Lets us measure cost-per-email per ad set and join spend
// -> run -> conversion. Netlify Forms stays in parallel as the email list of record.
//
// Browser-called (labs.switchable.org.uk), so CORS + verify_jwt=false (config.toml).
// Role: connects via SUPABASE_DB_URL (superuser) and drops to functions_writer via
// SET LOCAL ROLE, same pattern as netlify-partial-capture / netlify-lead-router.
// Related: migration 0181_labs_events.sql, labs/docs/current-handoff.md.

import postgres from "npm:postgres@3";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL is not set. Should be auto-injected by Supabase for Edge Functions.");
}

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

const ALLOWED_TOOLS = new Set(["amistuck", "gaply"]);
const ALLOWED_EVENTS = new Set(["run", "unlock_intent", "signup"]);

// Bot detection (mirrors log-page-view): keeps obvious crawlers/scripts out of
// the funnel denominators. is_bot is stored, not rejected, so it's auditable.
const BOT_REGEX =
  /(bot|crawl|spider|scrape|preview|monitor|fetch|checker|scan|headless|curl|wget|python-requests|node-fetch|axios|java\/|go-http-client|okhttp|libwww|postman|googlebot|bingbot|yandex|baidu|duckduckbot|slurp|applebot|ahrefs|semrush|mj12bot|dotbot|moz\.com|blexbot|facebookexternalhit|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|whatsapp|pinterest|pingdom|statuscake|uptimerobot)/i;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
};

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Light origin guard: only our own surfaces. Not security (the data is low-value
  // analytics + consented emails), just keeps random cross-site posts out.
  const origin = req.headers.get("origin") || req.headers.get("referer") || "";
  if (!originAllowed(origin)) return json({ error: "forbidden" }, 403);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const tool = firstString(body["tool"]);
  if (!tool || !ALLOWED_TOOLS.has(tool)) return json({ error: "invalid_tool" }, 400);

  const event = firstString(body["event"]);
  if (!event || !ALLOWED_EVENTS.has(event)) return json({ error: "invalid_event" }, 400);

  const session_id = firstString(body["session_id"]);
  // Email only belongs on a signup. Discard it on run/unlock_intent so we never
  // store an address against a non-signup event (data minimisation).
  let email = event === "signup" ? firstString(body["email"]) : null;
  if (email) email = email.slice(0, 200).toLowerCase();
  if (email && !EMAIL_RE.test(email)) email = null; // drop junk, don't reject the event
  const payload = asObject(body["payload"]);
  const attribution = asObject(body["attribution"]);
  const referrer = clip(firstString(body["referrer"]), 500);
  const userAgent = clip(firstString(body["user_agent"]), 500);
  const isBot = !userAgent || BOT_REGEX.test(userAgent);

  try {
    const [row] = await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      return await trx<Array<{ id: number }>>`
        INSERT INTO labs.events (
          tool, event, session_id, email, payload, attribution, referrer, user_agent, is_bot, schema_version
        ) VALUES (
          ${tool}, ${event}, ${session_id}, ${email},
          ${sql.json(payload)}, ${sql.json(attribution)},
          ${referrer}, ${userAgent}, ${isBot}, '1.0'
        )
        RETURNING id
      `;
    });
    return json({ status: "ok", id: row.id });
  } catch (err) {
    console.error("labs.events INSERT failed:", err);
    await persistDeadLetter(body, describeError(err));
    return json({ error: "internal" }, 500);
  }
});

// -------- helpers --------

function originAllowed(value: string): boolean {
  if (!value) return false;
  try {
    const host = new URL(value).hostname;
    // Production + this site's Netlify alias + its deploy previews + local dev.
    // Scoped to amistuck-labs, not all of *.netlify.app (anyone can host there).
    return (
      host === "labs.switchable.org.uk" ||
      host === "amistuck-labs.netlify.app" ||
      host.endsWith("--amistuck-labs.netlify.app") ||
      host === "localhost"
    );
  } catch {
    return false;
  }
}

function firstString(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length === 0 ? null : t;
  }
  return null;
}

function clip(v: string | null, n: number): string | null {
  return v ? v.slice(0, n) : null;
}

// Accept an object payload, drop oversized string values, cap key count.
function asObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (n++ >= 40) break;
    if (typeof val === "string" && val.length > 500) out[k] = val.slice(0, 500);
    else out[k] = val;
  }
  return out;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

async function persistDeadLetter(rawPayload: unknown, errorContext: string): Promise<void> {
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        INSERT INTO leads.dead_letter (source, raw_payload, error_context)
        VALUES ('edge_function_labs_event', ${sql.json(rawPayload ?? null)}, ${errorContext})
      `;
    });
  } catch (err) {
    console.error("dead_letter insert failed:", err);
  }
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}
