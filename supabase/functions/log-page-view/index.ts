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
// Payload (migration 0164):
//   {
//     experiment_id: string,
//     page_slug:     string,
//     variant:       "a" | "b",
//     session_id?:   string | null,
//     user_agent?:   string | null,
//     referrer?:     string | null,
//     utm_source?:   string | null,
//     utm_medium?:   string | null,
//     utm_campaign?: string | null
//   }
//
// session_id is the per-browser-session UUID minted by variant-router.ts.
// When supplied, the INSERT becomes an UPSERT via ON CONFLICT DO NOTHING
// against the partial unique index added by migration 0162. When NULL, a
// fresh row is inserted unconditionally (raw load count contribution only).
//
// is_bot is computed server-side from user_agent (regex) and stored on the
// row. The dashboard uses RPC v3 which filters is_bot=true out of unique_sessions.
//
// Response: always 200 (caller ignores the response body anyway).

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

// Bot / crawler / link-previewer detection.
//
// Anything matching this regex on its user_agent gets is_bot=true and is
// excluded from /admin/experiments unique_sessions. The categories covered:
//
// - Search-engine crawlers: googlebot, bingbot, yandex, baidu, duckduckbot,
//   slurp (Yahoo), applebot
// - SEO/marketing scanners: ahrefs, semrush, mj12bot, dotbot, moz, blexbot
// - Social link previewers: facebookexternalhit, twitterbot, linkedinbot,
//   slackbot, discordbot, telegrambot, whatsapp, skypeurlpreview, pinterest
// - Uptime / monitoring: pingdom, statuscake, uptimerobot, site24x7, newrelic
// - HTTP clients commonly used by scrapers: curl, wget, python-requests,
//   node-fetch, axios, java/, go-http-client, okhttp, libwww, postman
// - Generic catchalls: anything containing "bot", "crawl", "spider",
//   "scrape", "preview", "monitor", "fetch", "checker", "scan", "headless"
//
// False positive risk: a real human running a browser identifying as
// "headless Chrome" or with "fetch" in their UA string gets filtered.
// Acceptable: those are extremely rare in real traffic and the dashboard
// surfaces bot_sessions separately so the count is auditable.
//
// False negative risk: a sophisticated scraper spoofing a real browser UA
// slips through. Acceptable: their volume is low and they'd dedupe by
// session_id if they accept cookies (which most do; cookie-rejecting
// scrapers naturally limit themselves).
const BOT_REGEX =
  /(bot|crawl|spider|scrape|preview|monitor|fetch|checker|scan|headless|curl|wget|python-requests|node-fetch|axios|java\/|go-http-client|okhttp|libwww|postman|googlebot|bingbot|yandex|baidu|duckduckbot|slurp|applebot|ahrefs|semrush|mj12bot|dotbot|moz\.com|blexbot|facebookexternalhit|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|whatsapp|skypeurlpreview|pinterest|pingdom|statuscake|uptimerobot|site24x7|newrelic)/i;

function detectBot(userAgent: string | null | undefined): boolean {
  if (!userAgent || typeof userAgent !== "string") {
    // No user-agent at all is suspicious — humans always have one. Default
    // to is_bot=true so we don't inflate denominators with anonymous clients.
    return true;
  }
  return BOT_REGEX.test(userAgent);
}

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

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

  const {
    experiment_id,
    page_slug,
    variant,
    session_id,
    user_agent,
    referrer,
    utm_source,
    utm_medium,
    utm_campaign,
  } = body as {
    experiment_id?: string;
    page_slug?: string;
    variant?: string;
    session_id?: string | null;
    user_agent?: string | null;
    referrer?: string | null;
    utm_source?: string | null;
    utm_medium?: string | null;
    utm_campaign?: string | null;
  };

  if (
    typeof experiment_id !== "string" || !experiment_id.trim() ||
    typeof page_slug !== "string" || !page_slug.trim() ||
    (variant !== "a" && variant !== "b")
  ) {
    return new Response("Bad request — missing or invalid fields", { status: 400 });
  }

  // session_id is optional. Normalise: accept null, undefined, "", and any
  // non-string as "no session". Otherwise keep the trimmed UUID.
  const normalisedSessionId =
    typeof session_id === "string" && session_id.trim() ? session_id.trim() : null;

  const normalisedUserAgent  = trimOrNull(user_agent);
  const normalisedReferrer   = trimOrNull(referrer);
  const normalisedUtmSource  = trimOrNull(utm_source);
  const normalisedUtmMedium  = trimOrNull(utm_medium);
  const normalisedUtmCampaign = trimOrNull(utm_campaign);
  const isBot = detectBot(normalisedUserAgent);

  try {
    await sql`
      INSERT INTO ads_switchable.page_views
        (experiment_id, page_slug, variant, session_id,
         user_agent, referrer, utm_source, utm_medium, utm_campaign, is_bot)
      VALUES
        (${experiment_id.trim()}, ${page_slug.trim()}, ${variant}, ${normalisedSessionId},
         ${normalisedUserAgent}, ${normalisedReferrer},
         ${normalisedUtmSource}, ${normalisedUtmMedium}, ${normalisedUtmCampaign},
         ${isBot})
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
