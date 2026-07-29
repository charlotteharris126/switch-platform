// Edge Function: netlify-employer-lead-router
// Receives the Netlify Forms outgoing webhook for the Switchable for Business
// employer-lead form (`s4b-employer-lead-v1`). Normalises into leads.submissions
// (lead_type='employer_apprenticeship'), routes to Riverside, fires the sheet
// append + U1-employer + U2-provider Brevo emails, and sends the owned
// server-side Meta CAPI Lead.
//
// The normalisation, INSERT, routing and fan-out all live in
// _shared/employer-lead-core.ts, shared byte-for-byte with
// meta-instant-employer-lead-router (the Meta Instant Form receiver). This
// handler owns only: the form_name gate (its inbound auth), the fixed
// source_form value, and fireCapi=true (on-site submissions need the server
// CAPI Lead; Instant Form ones don't). Changing the core means redeploying
// BOTH functions.
//
// Role: the core connects via Supabase's auto-injected SUPABASE_DB_URL and
// drops to `functions_writer` per transaction.

import {
  describeError,
  firstTopLevelString,
  json,
  persistDeadLetter,
  processEmployerLead,
  type JsonValue,
} from "../_shared/employer-lead-core.ts";

const DEAD_LETTER_SOURCE = "edge_function_employer_lead_router";

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
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

  const formName = firstTopLevelString(body, "form_name", "form-name");
  if (formName !== "s4b-employer-lead-v1") {
    return json({ status: "ignored", form_name: formName, reason: "wrong form for employer-lead-router" });
  }

  const data = (body.data ?? body.payload ?? body) as Record<string, JsonValue>;

  let result;
  try {
    result = await processEmployerLead(data, rawBody, {
      sourceForm: "s4b-employer-lead-v1",
      fireCapi: true,
    });
  } catch (err) {
    console.error("employer lead processing failed:", describeError(err));
    await persistDeadLetter(rawBody, `processing failed: ${describeError(err)}`, DEAD_LETTER_SOURCE);
    return json({ status: "dead_letter", reason: describeError(err) });
  }

  const runtime = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (result.task && runtime?.waitUntil) runtime.waitUntil(result.task);

  return json({ status: "ok", submission_id: result.submissionId, outcome: result.outcome });
});
