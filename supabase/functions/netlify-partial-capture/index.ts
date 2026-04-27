// Edge Function: netlify-partial-capture
// Receives progressive form step data directly from the browser (NOT via Netlify
// Forms webhook) and upserts it into leads.partials keyed by session_id.
//
// Scope: non-PII funnel drop-off tracking for the Switchable multi-step forms
// (switchable-self-funded on /find-your-course/, switchable-funded on generated
// funded course pages). On final Netlify submit, netlify-lead-router flips
// is_complete = true on the matching partial row.
//
// Architectural context: see platform/docs/data-architecture.md (leads.partials
// section), migration 0004_add_leads_partials.sql, and Mira's architectural
// review in changelog entry 2026-04-19.
//
// Role: connects via SUPABASE_DB_URL (postgres superuser) and drops to
// functions_writer via SET LOCAL ROLE, same pattern as netlify-lead-router.
// See .claude/rules/data-infrastructure.md §5 + §6.

import postgres from "npm:postgres@3";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error(
    "SUPABASE_DB_URL is not set. Should be auto-injected by Supabase for Edge Functions.",
  );
}

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

// Allowed form names. Anything outside this list is rejected without touching
// the DB — keeps the upsert surface narrow and prevents random payloads from
// populating leads.partials.
const ALLOWED_FORMS = new Set([
  "switchable-self-funded",
  "switchable-funded",
]);

// Per-session upsert cap. A legit multi-step session makes ~8-15 upserts
// (one per step, plus back-button edits). 50 gives comfortable headroom and
// blocks a single abusive session from flooding the table. Enforced by
// leads.partials.upsert_count — incremented on every upsert, rejected here
// once it crosses the cap. Distributed abuse is out of scope for pilot
// volume — Cloudflare in front if/when that becomes a real concern.
const MAX_UPSERTS_PER_SESSION = 50;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface PartialPayload {
  session_id: string;
  form_name: string;
  step_reached: number;
  answers: Record<string, JsonValue>;
  page_url: string | null;
  course_id: string | null;
  funding_category: string | null;
  funding_route: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  fbclid: string | null;
  gclid: string | null;
  referrer: string | null;
  user_agent: string | null;
  device_type: string | null;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
};

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  let body: JsonValue;
  try {
    body = await req.json();
  } catch (_err) {
    return json({ error: "invalid_json" }, 400);
  }

  const payload = parsePayload(body);
  if (payload.error) {
    return json({ error: payload.error }, 400);
  }
  const p = payload.value;

  try {
    const result = await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;

      // Rate-limit check: reject if this session has already crossed the cap.
      // Lock the row for the duration of the transaction to avoid the
      // read-check-then-write race under concurrent requests.
      const existing = await trx<Array<{ upsert_count: number }>>`
        SELECT upsert_count
        FROM leads.partials
        WHERE session_id = ${p.session_id}
        FOR UPDATE
      `;
      if (
        existing.length > 0 &&
        existing[0].upsert_count >= MAX_UPSERTS_PER_SESSION
      ) {
        return { rateLimited: true };
      }

      const [row] = await trx<Array<{ id: number; step_reached: number; upsert_count: number }>>`
        INSERT INTO leads.partials (
          session_id, schema_version, form_name,
          page_url, course_id, funding_category, funding_route,
          step_reached, answers,
          utm_source, utm_medium, utm_campaign, utm_content,
          fbclid, gclid, referrer,
          user_agent, device_type
        ) VALUES (
          ${p.session_id}, '1.0', ${p.form_name},
          ${p.page_url}, ${p.course_id}, ${p.funding_category}, ${p.funding_route},
          ${p.step_reached}, ${sql.json(p.answers)},
          ${p.utm_source}, ${p.utm_medium}, ${p.utm_campaign}, ${p.utm_content},
          ${p.fbclid}, ${p.gclid}, ${p.referrer},
          ${p.user_agent}, ${p.device_type}
        )
        ON CONFLICT (session_id) DO UPDATE SET
          step_reached     = GREATEST(leads.partials.step_reached, EXCLUDED.step_reached),
          answers          = leads.partials.answers || EXCLUDED.answers,
          page_url         = COALESCE(EXCLUDED.page_url, leads.partials.page_url),
          course_id        = COALESCE(EXCLUDED.course_id, leads.partials.course_id),
          funding_category = COALESCE(EXCLUDED.funding_category, leads.partials.funding_category),
          funding_route    = COALESCE(EXCLUDED.funding_route, leads.partials.funding_route),
          utm_source    = COALESCE(leads.partials.utm_source,    EXCLUDED.utm_source),
          utm_medium    = COALESCE(leads.partials.utm_medium,    EXCLUDED.utm_medium),
          utm_campaign  = COALESCE(leads.partials.utm_campaign,  EXCLUDED.utm_campaign),
          utm_content   = COALESCE(leads.partials.utm_content,   EXCLUDED.utm_content),
          fbclid        = COALESCE(leads.partials.fbclid,        EXCLUDED.fbclid),
          gclid         = COALESCE(leads.partials.gclid,         EXCLUDED.gclid),
          referrer      = COALESCE(leads.partials.referrer,      EXCLUDED.referrer),
          user_agent    = COALESCE(leads.partials.user_agent,    EXCLUDED.user_agent),
          device_type   = COALESCE(leads.partials.device_type,   EXCLUDED.device_type),
          upsert_count  = leads.partials.upsert_count + 1,
          last_seen_at  = now(),
          updated_at    = now()
        RETURNING id, step_reached, upsert_count
      `;
      return { id: row.id, step_reached: row.step_reached };
    });

    if ("rateLimited" in result) {
      return json({ error: "rate_limited" }, 429);
    }
    return json({
      status: "ok",
      session_id: p.session_id,
      step_reached: result.step_reached,
    });
  } catch (err) {
    console.error("leads.partials UPSERT failed. err:", err);
    const message = describeError(err);
    // Mirror netlify-lead-router pattern: never lose the payload at the boundary.
    await persistDeadLetter(body, `leads.partials UPSERT failed: ${message}`);
    return json({ error: "internal", detail: message }, 500);
  }
});

// -------- helpers --------

interface ParseOk { value: PartialPayload; error?: undefined }
interface ParseErr { error: string; value?: undefined }
type Parsed = ParseOk | ParseErr;

function parsePayload(body: JsonValue): Parsed {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "body_not_object" };
  }
  const b = body as Record<string, JsonValue>;

  const session_id = firstString(b["session_id"]);
  if (!session_id || !UUID_RE.test(session_id)) {
    return { error: "invalid_session_id" };
  }

  const form_name = firstString(b["form_name"]);
  if (!form_name || !ALLOWED_FORMS.has(form_name)) {
    return { error: "disallowed_form_name" };
  }

  const step_reached = toInt(b["step_reached"]);
  if (step_reached === null || step_reached < 1 || step_reached > 99) {
    return { error: "invalid_step_reached" };
  }

  const rawAnswers = b["answers"];
  let answers: Record<string, JsonValue> = {};
  if (rawAnswers && typeof rawAnswers === "object" && !Array.isArray(rawAnswers)) {
    answers = sanitiseAnswers(rawAnswers as Record<string, JsonValue>);
  }

  return {
    value: {
      session_id,
      form_name,
      step_reached,
      answers,
      page_url: firstString(b["page_url"]),
      course_id: firstString(b["course_id"]),
      funding_category: firstString(b["funding_category"]),
      funding_route: firstString(b["funding_route"]),
      utm_source: firstString(b["utm_source"]),
      utm_medium: firstString(b["utm_medium"]),
      utm_campaign: firstString(b["utm_campaign"]),
      utm_content: firstString(b["utm_content"]),
      fbclid: firstString(b["fbclid"]),
      gclid: firstString(b["gclid"]),
      referrer: firstString(b["referrer"]),
      user_agent: firstString(b["user_agent"]),
      device_type: firstString(b["device_type"]),
    },
  };
}

// Strip any keys that look like PII. Belt-and-braces defence — the client
// tracker is meant to send non-PII only, but a coding mistake that leaks
// first_name/email/phone should not land in leads.partials.
const PII_KEY_BLOCKLIST = new Set([
  "first_name", "last_name", "name", "full_name",
  "email", "phone", "mobile", "telephone",
  "address", "postcode", "dob", "date_of_birth",
]);

function sanitiseAnswers(obj: Record<string, JsonValue>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (PII_KEY_BLOCKLIST.has(key.toLowerCase())) continue;
    // Cap each answer string at 500 chars to prevent someone stuffing the
    // answers blob with a huge payload.
    if (typeof value === "string" && value.length > 500) {
      out[key] = value.slice(0, 500);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function firstString(v: JsonValue): string | null {
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  return null;
}

function toInt(v: JsonValue): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

async function persistDeadLetter(
  rawPayload: JsonValue,
  errorContext: string,
): Promise<void> {
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        INSERT INTO leads.dead_letter (source, raw_payload, error_context)
        VALUES ('edge_function_partial_capture', ${sql.json(rawPayload ?? null)}, ${errorContext})
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
