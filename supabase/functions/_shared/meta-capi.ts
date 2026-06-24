// _shared/meta-capi.ts
//
// Server-side Meta Conversions API (CAPI) Lead sender + logger.
//
// This is the OWNED, monitored redundant path for the Meta "Lead" conversion,
// fired directly from the lead-router Edge Functions the moment a lead lands.
// It runs ALONGSIDE the browser pixel + Stape sGTM container (which we keep for
// match quality); Meta deduplicates the two by the shared `event_id` that
// meta-dedup.js already injects into every form. Either path failing no longer
// loses the conversion, and every send here is logged to leads.capi_log so a
// daily reconcile can alarm on any gap.
//
// Full plan + impact assessment: platform/docs/capi-server-side-scoping-2026-06-15.md
//
// Why a direct server-to-server send (not another GTM/Stape hop): the browser →
// GTM → Stape → Meta chain has four hops in three dashboards nobody monitors,
// on a free Stape tier that auto-disables on low traffic. It silently dropped
// B2B server events for ~2 weeks. This path is ours end to end and observable.
//
// Secrets (Deno.env, set in Supabase function config — NOT in any iCloud file):
//   META_CAPI_ACCESS_TOKEN   — one System User token (never-expire), authorised
//                              on BOTH pixel datasets. Required.
//   META_CAPI_TEST_EVENT_CODE — optional; when set, sends ride Events Manager
//                              "Test Events" only (use during verification).
//   META_CAPI_DISABLED       — optional kill switch; "true" skips the send and
//                              logs an attempt with a 'disabled' note.

const GRAPH_API_VERSION = "v21.0"; // bump deliberately; matches the Stape tag era

export type CapiBrand = "b2c" | "b2b" | "labs";

export interface CapiLeadInput {
  brand: CapiBrand;
  pixelId: string;
  /** Override the Meta event name. Defaults to "Lead". Use "Subscribe" for the
   *  Gaply subscribe_click event. Must be a standard or custom Meta event name. */
  eventName?: string;
  eventId: string | null; // shared dedup key from meta-dedup.js hidden input
  eventSourceUrl: string | null; // page_url of the thank-you page
  eventTimeMs?: number; // defaults to now()
  // Raw (unhashed) user data — hashed here per Meta spec before send.
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  zip?: string | null;
  country?: string | null; // ISO-2; lowercased + hashed
  externalId?: string | null; // e.g. submission id; hashed
  // Browser identifiers — sent RAW (never hashed).
  fbc?: string | null; // _fbc cookie value (already "fb.1.<ts>.<fbclid>")
  fbp?: string | null; // _fbp cookie value
  fbclid?: string | null; // used to rebuild fbc when the cookie is absent
  // custom_data
  value?: number | null;
  currency?: string; // default GBP
  contentCategory?: string | null;
}

export interface CapiResult {
  ok: boolean;
  httpStatus: number | null;
  eventsReceived: number | null;
  fbtraceId: string | null;
  errorBody: string | null;
  raw: unknown;
}

// SHA-256 hex of a normalised string (trim + lowercase), per Meta's hashing spec.
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function clean(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = String(v).trim().toLowerCase();
  return t.length ? t : null;
}

// Already-hashed values (64-char hex) are passed through, so a caller can hand
// us pre-hashed data without double-hashing.
function isHashed(v: string): boolean {
  return /^[a-f0-9]{64}$/.test(v);
}

async function hashField(v: string | null | undefined): Promise<string | undefined> {
  const c = clean(v);
  if (!c) return undefined;
  return isHashed(c) ? c : await sha256Hex(c);
}

// Phone: digits only (drop +, spaces, punctuation) before hashing.
async function hashPhone(v: string | null | undefined): Promise<string | undefined> {
  if (v == null) return undefined;
  const digits = String(v).replace(/[^0-9]/g, "");
  if (!digits.length) return undefined;
  return isHashed(digits) ? digits : await sha256Hex(digits);
}

// UK postcode etc.: strip spaces before hashing.
async function hashZip(v: string | null | undefined): Promise<string | undefined> {
  const c = clean(v);
  if (!c) return undefined;
  const z = c.replace(/\s+/g, "");
  return isHashed(z) ? z : await sha256Hex(z);
}

// Rebuild the Facebook click id from fbclid when the _fbc cookie wasn't captured
// (same scheme the Stape tag uses): fb.1.<event_time_ms>.<fbclid>.
function deriveFbc(fbc: string | null | undefined, fbclid: string | null | undefined, tsMs: number): string | undefined {
  if (fbc) return fbc;
  if (fbclid) return `fb.1.${tsMs}.${fbclid}`;
  return undefined;
}

// Build + POST the Lead event. Never throws — returns a CapiResult either way so
// the caller can log it and move on (the lead insert must never fail on CAPI).
export async function sendCapiLead(input: CapiLeadInput): Promise<CapiResult> {
  const fail = (errorBody: string, httpStatus: number | null = null): CapiResult => ({
    ok: false,
    httpStatus,
    eventsReceived: null,
    fbtraceId: null,
    errorBody,
    raw: null,
  });

  if ((Deno.env.get("META_CAPI_DISABLED") ?? "").toLowerCase() === "true") {
    return fail("disabled via META_CAPI_DISABLED");
  }
  const accessToken = Deno.env.get("META_CAPI_ACCESS_TOKEN");
  if (!accessToken) return fail("META_CAPI_ACCESS_TOKEN not set");
  if (!input.pixelId) return fail("missing pixelId");

  const tsMs = input.eventTimeMs ?? Date.now();

  const user_data: Record<string, string> = {};
  const em = await hashField(input.email);
  if (em) user_data.em = em;
  const ph = await hashPhone(input.phone);
  if (ph) user_data.ph = ph;
  const fn = await hashField(input.firstName);
  if (fn) user_data.fn = fn;
  const ln = await hashField(input.lastName);
  if (ln) user_data.ln = ln;
  const zp = await hashZip(input.zip);
  if (zp) user_data.zp = zp;
  const country = await hashField(input.country);
  if (country) user_data.country = country;
  const externalId = await hashField(input.externalId);
  if (externalId) user_data.external_id = externalId;
  const fbc = deriveFbc(input.fbc, input.fbclid, tsMs);
  if (fbc) user_data.fbc = fbc;
  if (input.fbp) user_data.fbp = input.fbp;

  const custom_data: Record<string, unknown> = {};
  if (input.value != null) custom_data.value = input.value;
  if (input.value != null) custom_data.currency = input.currency ?? "GBP";
  if (input.contentCategory) custom_data.content_category = input.contentCategory;

  const event: Record<string, unknown> = {
    event_name: input.eventName ?? "Lead",
    event_time: Math.round(tsMs / 1000),
    action_source: "website",
    user_data,
  };
  if (input.eventId) event.event_id = input.eventId; // dedup key (must match pixel)
  if (input.eventSourceUrl) event.event_source_url = input.eventSourceUrl;
  if (Object.keys(custom_data).length) event.custom_data = custom_data;

  const body: Record<string, unknown> = { data: [event] };
  const testCode = Deno.env.get("META_CAPI_TEST_EVENT_CODE");
  if (testCode) body.test_event_code = testCode;

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${input.pixelId}/events?access_token=${encodeURIComponent(accessToken)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return fail(`fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown = null;
  let text = "";
  try {
    text = await res.text();
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const eventsReceived = typeof obj.events_received === "number" ? obj.events_received : null;
  const fbtraceId = typeof obj.fbtrace_id === "string" ? obj.fbtrace_id : null;
  const ok = res.ok && (eventsReceived ?? 0) >= 1;

  return {
    ok,
    httpStatus: res.status,
    eventsReceived,
    fbtraceId,
    errorBody: ok ? null : text.slice(0, 2000),
    raw: parsed,
  };
}

// Insert one audit row into leads.capi_log. Mirrors the SET LOCAL ROLE pattern
// used across the routers. `sql` is the shared postgres client; pass the same
// instance the router uses. Never throws (logging must not break the request).
// deno-lint-ignore no-explicit-any
export async function logCapiSend(
  // deno-lint-ignore no-explicit-any
  sql: any,
  args: {
    submissionId: number | null;
    brand: CapiBrand;
    pixelId: string;
    /** Defaults to "Lead". Must match what was passed to sendCapiLead. */
    eventName?: string;
    eventId: string | null;
    result: CapiResult;
  },
): Promise<void> {
  try {
    await sql.begin(async (tx: any) => {
      await tx`SET LOCAL ROLE functions_writer`;
      await tx`
        INSERT INTO leads.capi_log (
          submission_id, brand, pixel_id, event_name, event_id,
          http_status, events_received, fbtrace_id, error_body, raw_response
        ) VALUES (
          ${args.submissionId}, ${args.brand}, ${args.pixelId}, ${args.eventName ?? "Lead"}, ${args.eventId},
          ${args.result.httpStatus}, ${args.result.eventsReceived}, ${args.result.fbtraceId},
          ${args.result.errorBody}, ${args.result.raw === null ? null : tx.json(args.result.raw)}
        )
      `;
    });
  } catch (err) {
    console.error("logCapiSend failed:", err instanceof Error ? err.message : String(err));
  }
}
