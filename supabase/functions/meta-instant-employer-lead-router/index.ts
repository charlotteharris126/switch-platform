// Edge Function: meta-instant-employer-lead-router
// Receives Meta Instant Form (lead ad) submissions for the Switchable for
// Business Employer route, delivered by a Zapier/Make "Facebook Lead Ads"
// trigger → "Webhooks" POST. Meta's Instant Form never touches the site, so
// none of the on-site pipeline fires; this function is the entry point that
// lands the lead in leads.submissions and routes it to Riverside identically
// to the on-site form.
//
// Shares all normalisation, INSERT, routing and fan-out with
// netlify-employer-lead-router via _shared/employer-lead-core.ts. This handler
// owns only its three differences:
//   1. Auth: a shared-secret header (x-instant-secret == META_INSTANT_LEAD_SECRET).
//      Unlike the Netlify webhook (gated by form_name from a trusted Netlify
//      origin), this endpoint's URL could leak, so it requires the secret.
//   2. source_form = 's4b-employer-lead-meta-instant-v1' (distinct origin so
//      Instant Form vs on-site landing-page performance is comparable in
//      leads.submissions and downstream reporting).
//   3. fireCapi = false. An Instant Form submission is an on-Meta conversion
//      Meta already records against the ad; a server-side CAPI Lead here would
//      double-count. (There's also no browser pixel fire, so no event_id/fbp/fbc
//      to dedup against anyway.)
//
// Expected body: a flat JSON object whose keys match the core's field names
// (email, company_name, full_name, phone, role_title, company_size_band,
// sector, levy_status, interest, urgency, candidate_in_mind,
// existing_apprentices, headcount_estimate, standards_interested,
// additional_notes, terms_accepted, marketing_opt_in, plus optional
// utm_source/utm_medium/utm_campaign/utm_content and referrer). Map the Meta
// form's questions to these keys in the Zapier/Make step. A `.data` or
// `.payload` wrapper is also accepted.

import {
  describeError,
  json,
  persistDeadLetter,
  processEmployerLead,
  type JsonValue,
} from "../_shared/employer-lead-core.ts";

const DEAD_LETTER_SOURCE = "edge_function_meta_instant_employer_lead_router";
const SOURCE_FORM = "s4b-employer-lead-meta-instant-v1";

// Shared secret for the Zapier/Make → EF hop. Set with:
//   supabase secrets set META_INSTANT_LEAD_SECRET=<long-random-string>
const INSTANT_SECRET = Deno.env.get("META_INSTANT_LEAD_SECRET");

// Constant-time string compare so a wrong secret can't be probed byte-by-byte
// via response timing.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Auth gate. Fail closed if the secret isn't configured.
  if (!INSTANT_SECRET) {
    console.error("META_INSTANT_LEAD_SECRET not set — refusing all requests");
    return json({ status: "error", reason: "receiver not configured" }, 503);
  }
  const provided = req.headers.get("x-instant-secret") ?? "";
  if (!timingSafeEqual(provided, INSTANT_SECRET)) {
    return json({ status: "unauthorized" }, 401);
  }

  let rawBody: JsonValue;
  try {
    rawBody = await req.json();
  } catch (_err) {
    await persistDeadLetter(null, "Invalid JSON body", DEAD_LETTER_SOURCE);
    return json({ status: "dead_letter", reason: "Invalid JSON body" });
  }

  const body = rawBody as Record<string, JsonValue> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    await persistDeadLetter(rawBody, "Request body is not an object", DEAD_LETTER_SOURCE);
    return json({ status: "dead_letter", reason: "Request body is not an object" });
  }

  const data = (body.data ?? body.payload ?? body) as Record<string, JsonValue>;

  let result;
  try {
    result = await processEmployerLead(data, rawBody, {
      sourceForm: SOURCE_FORM,
      fireCapi: false,
    });
  } catch (err) {
    console.error("instant employer lead processing failed:", describeError(err));
    await persistDeadLetter(rawBody, `processing failed: ${describeError(err)}`, DEAD_LETTER_SOURCE);
    return json({ status: "dead_letter", reason: describeError(err) });
  }

  const runtime = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (result.task && runtime?.waitUntil) runtime.waitUntil(result.task);

  return json({ status: "ok", submission_id: result.submissionId, outcome: result.outcome });
});
