// Edge Function: go-resolve
//
// Powers the pretty short-link. The site route switchable.org.uk/go/<code>
// (switchable/site, Mable) fronts this: it calls go-resolve?c=<code>, which
// looks the code up and 302-redirects to the full /funded/thank-you/ URL.
//
// Public (verify_jwt=false) — it's a plain redirect, no secret. The code itself
// is the unguessable token. On an unknown code it redirects to the site home
// rather than erroring, so a mistyped/expired link never dead-ends the learner.

import postgres from "npm:postgres@3";
import { resolveShortLink } from "../_shared/short-link.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) throw new Error("SUPABASE_DB_URL not set");
const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 20, prepare: false });

const FALLBACK_URL = "https://switchable.org.uk/";
const CODE_RE = /^[a-z2-9]{4,12}$/; // charset + length guard

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  // Accept ?c=<code> or a trailing path segment (/go-resolve/<code>).
  const code = (url.searchParams.get("c") ?? url.pathname.split("/").filter(Boolean).pop() ?? "")
    .trim().toLowerCase();

  if (!code || !CODE_RE.test(code)) return redirect(FALLBACK_URL);

  try {
    // The EF connects as the postgres role (SUPABASE_DB_URL), which reads
    // through RLS — a plain SELECT is fine, no role switch needed for a lookup.
    const target = await resolveShortLink(sql, code);
    return redirect(target ?? FALLBACK_URL);
  } catch (err) {
    console.error("go-resolve failed:", String(err));
    return redirect(FALLBACK_URL);
  }
});
