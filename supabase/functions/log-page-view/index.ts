// Edge Function: log-page-view
// Receives fire-and-forget POST requests from the Netlify variant-router Edge
// Function on every experiment page load. Inserts one row into
// ads_switchable.page_views so /admin/experiments can show per-variant view
// counts and view-to-lead conversion rates.
//
// Called server-to-server (Netlify edge → Supabase edge), not from a browser.
// No JWT verification. No shared-secret auth — this is a no-PII analytics
// write endpoint and the risk of view count inflation from spoofed requests
// is low noise. Deno.env.get does not reliably read Netlify env vars in the
// edge runtime, making a shared-secret check impractical without using
// Netlify-specific APIs.
//
// Payload: { experiment_id: string, page_slug: string, variant: "a" | "b",
//            session_id?: string | null }
// session_id is the per-browser-session UUID minted by variant-router.ts when
// the visitor has granted Cookiebot statistics consent. Optional —
// non-consenting visitors don't supply it; in that case a fresh row is
// inserted unconditionally (counts as a raw load, contributes 0 to
// unique-session totals on /admin/experiments). When supplied, the INSERT
// becomes an UPSERT via ON CONFLICT DO NOTHING against the partial unique
// index added by migration 0162 (UNIQUE on (experiment_id, page_slug,
// variant, session_id) WHERE session_id IS NOT NULL), so refreshes and
// back-button revisits within the same 30-minute session don't multiply
// the row count.
//
// Response: always 200 (caller ignores the response body anyway).
//
// Always returns 200 even on insert failure so the caller (variant-router)
// never retries or blocks on a transient DB hiccup. Errors are logged to
// the Supabase Edge Function log stream for monitoring.

import postgres from "npm:postgres@3";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");

if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL is not set.");
}

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 10,
  connect_timeout: 5,
  prepare: false,
});

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request — invalid JSON", { status: 400 });
  }

  const { experiment_id, page_slug, variant, session_id } = body as {
    experiment_id?: string;
    page_slug?: string;
    variant?: string;
    session_id?: string | null;
  };

  if (
    typeof experiment_id !== "string" || !experiment_id.trim() ||
    typeof page_slug !== "string" || !page_slug.trim() ||
    (variant !== "a" && variant !== "b")
  ) {
    return new Response("Bad request — missing or invalid fields", { status: 400 });
  }

  // session_id is optional. Normalise: accept null, undefined, "", and any
  // non-string as "no session". Otherwise keep the trimmed UUID. The partial
  // unique index in migration 0162 only kicks in when session_id IS NOT NULL,
  // so passing null falls through to a plain INSERT (raw load count) while
  // passing a UUID upserts (one row per session per experiment+page+variant).
  const normalisedSessionId =
    typeof session_id === "string" && session_id.trim() ? session_id.trim() : null;

  try {
    await sql`
      INSERT INTO ads_switchable.page_views
        (experiment_id, page_slug, variant, session_id)
      VALUES
        (${experiment_id.trim()}, ${page_slug.trim()}, ${variant}, ${normalisedSessionId})
      ON CONFLICT (experiment_id, page_slug, variant, session_id)
        WHERE session_id IS NOT NULL
      DO NOTHING
    `;
  } catch (err) {
    console.error(
      "page_views INSERT failed:",
      err instanceof Error ? err.message : String(err),
    );
    // Return 200 anyway — caller is fire-and-forget and should not retry on
    // transient DB errors. The missing view row is analytics noise, not a
    // data-loss event.
  }

  return new Response("ok", { status: 200 });
});