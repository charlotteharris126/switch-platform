// Edge Function: social-analytics-sync
//
// Pulls reaction / comment / share counts for every published social.drafts
// row published in the last 30 days. Writes a fresh social.post_analytics
// row per post on each run, so the table is a time-series snapshot.
//
// Runs on a daily pg_cron schedule (migration 0033). Token reads via the
// social.get_oauth_access_token() SECURITY DEFINER helper (migration 0031).
//
// Scope (G.4 first ship):
//   - linkedin_personal channel only. Other channels (linkedin_company,
//     meta_*, tiktok) are skipped silently. Each future channel adds a
//     switch case calling the relevant provider's analytics API.
//
// Auth: AUDIT_SHARED_SECRET via x-audit-key header.
//
// LinkedIn API:
//   - GET /rest/socialActions/{shareUrn}/likes?count=0     → paging.total
//   - GET /rest/socialActions/{shareUrn}/comments?count=0  → paging.total
//   The two-sub-resource pattern returns aggregated counts via the paging
//   envelope; the singular /rest/socialActions/{urn} endpoint returns one
//   action resource and isn't useful for share aggregates.
//   - Both calls require r_member_social scope. If the token was issued
//     before that scope was added, calls 401/403 — the function detects this
//     once and aborts the rest of the loop with a "reconnect required" flag.
//   - Personal-profile impressions are NOT reliably exposed via the public
//     API. Captured as NULL for now.
//   - Personal LinkedIn has connections, not followers — follower_count NULL.

import postgres from "npm:postgres@3";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");

if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL not set (should be auto-injected by Supabase)");
}

const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 20, prepare: false });

const LINKEDIN_VERSION = "202604";
const SYNC_LOOKBACK_DAYS = 30;
const SYNC_BATCH_LIMIT = 50;
const ANALYTICS_ADVISORY_LOCK_KEY = 8472640;

async function getAuditSharedSecret(): Promise<string> {
  const rows = await sql<Array<{ secret: string }>>`
    SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
  `;
  return rows[0].secret;
}

interface PublishedDraftRow {
  draft_id: string;
  brand: string;
  channel: string;
  external_post_id: string;
}

interface SyncResult {
  draft_id: string;
  outcome: "captured" | "skipped" | "failed";
  reactions?: number | null;
  comments?: number | null;
  error?: string;
}

const FETCH_TIMEOUT_MS = 8000;

// Fetch reaction + comment counts for one personal-profile post.
// Two parallel sub-resource calls; read paging.total from each.
async function fetchLinkedInPersonalAnalytics(
  postUrn: string,
  accessToken: string,
): Promise<
  | { ok: true; reactions: number | null; comments: number | null }
  | { ok: false; status: number; body: string; isAuthError: boolean }
> {
  const encodedUrn = encodeURIComponent(postUrn);
  const baseHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "LinkedIn-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };

  let likesRes: Response;
  let commentsRes: Response;
  try {
    [likesRes, commentsRes] = await Promise.all([
      fetch(`https://api.linkedin.com/rest/socialActions/${encodedUrn}/likes?count=0`, {
        headers: baseHeaders,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }),
      fetch(`https://api.linkedin.com/rest/socialActions/${encodedUrn}/comments?count=0`, {
        headers: baseHeaders,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }),
    ]);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: `Network/timeout: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
      isAuthError: false,
    };
  }

  // Auth/scope failure on either call — surface the same error and let the
  // caller abort the loop. Token issued before r_member_social was added
  // returns 403 here; expired token returns 401.
  if (likesRes.status === 401 || likesRes.status === 403 || commentsRes.status === 401 || commentsRes.status === 403) {
    const status = likesRes.status === 401 || likesRes.status === 403 ? likesRes.status : commentsRes.status;
    const which = likesRes.status === 401 || likesRes.status === 403 ? likesRes : commentsRes;
    const body = await which.text().catch(() => "");
    return { ok: false, status, body: body.slice(0, 500), isAuthError: true };
  }

  if (!likesRes.ok) {
    const body = await likesRes.text().catch(() => "");
    return { ok: false, status: likesRes.status, body: `(likes) ${body}`.slice(0, 500), isAuthError: false };
  }
  if (!commentsRes.ok) {
    const body = await commentsRes.text().catch(() => "");
    return { ok: false, status: commentsRes.status, body: `(comments) ${body}`.slice(0, 500), isAuthError: false };
  }

  const likesData = await likesRes.json().catch(() => ({} as Record<string, unknown>));
  const commentsData = await commentsRes.json().catch(() => ({} as Record<string, unknown>));

  const likesPaging = (likesData as Record<string, unknown>).paging as Record<string, unknown> | undefined;
  const commentsPaging = (commentsData as Record<string, unknown>).paging as Record<string, unknown> | undefined;

  const reactions = (likesPaging?.total as number | undefined) ?? null;
  const comments = (commentsPaging?.total as number | undefined) ?? null;

  return { ok: true, reactions, comments };
}

async function processOnePost(post: PublishedDraftRow): Promise<SyncResult & { isAuthError?: boolean }> {
  if (post.channel !== "linkedin_personal") {
    return { draft_id: post.draft_id, outcome: "skipped", error: `Channel ${post.channel} not yet wired in analytics-sync.` };
  }
  if (!post.external_post_id) {
    return { draft_id: post.draft_id, outcome: "skipped", error: "No external_post_id (URN missing)." };
  }

  // Read decrypted access token via helper
  let accessToken: string;
  try {
    const tokenResult = await sql<Array<{ token: string }>>`
      SELECT social.get_oauth_access_token(${post.brand}, ${post.channel}) AS token
    `;
    accessToken = tokenResult[0]?.token;
  } catch (err) {
    return {
      draft_id: post.draft_id,
      outcome: "failed",
      error: `Token read failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
    };
  }
  if (!accessToken) {
    return { draft_id: post.draft_id, outcome: "failed", error: "Token NULL/empty." };
  }

  const result = await fetchLinkedInPersonalAnalytics(post.external_post_id, accessToken);
  if (!result.ok) {
    return {
      draft_id: post.draft_id,
      outcome: "failed",
      error: `LinkedIn ${result.status}: ${result.body}`,
      isAuthError: result.isAuthError,
    };
  }

  // Insert a fresh post_analytics row (time-series snapshot)
  await sql`
    INSERT INTO social.post_analytics (draft_id, captured_at, reactions, comments, shares, follower_count, impressions, clicks)
    VALUES (
      ${post.draft_id}::uuid,
      now(),
      ${result.reactions},
      ${result.comments},
      NULL,
      NULL,
      NULL,
      NULL
    )
  `;

  return {
    draft_id: post.draft_id,
    outcome: "captured",
    reactions: result.reactions,
    comments: result.comments,
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const providedKey = req.headers.get("x-audit-key");
  let expectedKey: string;
  try {
    expectedKey = await getAuditSharedSecret();
  } catch (err) {
    console.error("Failed to read AUDIT_SHARED_SECRET from Vault:", err);
    return new Response("Vault read failed", { status: 500 });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Advisory lock — prevent concurrent runs
  const lockResult = await sql<Array<{ acquired: boolean }>>`
    SELECT pg_try_advisory_lock(${ANALYTICS_ADVISORY_LOCK_KEY}) AS acquired
  `;
  if (!lockResult[0]?.acquired) {
    return new Response(
      JSON.stringify({ checked_at: new Date().toISOString(), skipped: "another instance running" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  try {
    const cutoff = new Date(Date.now() - SYNC_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString();
    const posts = await sql<PublishedDraftRow[]>`
      SELECT id::text AS draft_id, brand, channel, external_post_id
        FROM social.drafts
       WHERE status = 'published'
         AND external_post_id IS NOT NULL
         AND published_at >= ${cutoff}
       ORDER BY published_at DESC
       LIMIT ${SYNC_BATCH_LIMIT}
    `;

    const results: Array<SyncResult & { isAuthError?: boolean }> = [];
    let authReconnectRequired = false;
    for (const post of posts) {
      const result = await processOnePost(post);
      results.push(result);
      // First auth/scope error aborts the loop — every post would hit the
      // same wall, no point burning quota or audit rows. Owner needs to
      // Reconnect on /social/settings to refresh the token's scope.
      if (result.isAuthError) {
        authReconnectRequired = true;
        break;
      }
    }

    return new Response(
      JSON.stringify({
        checked_at: new Date().toISOString(),
        processed: results.length,
        captured: results.filter((r) => r.outcome === "captured").length,
        skipped:  results.filter((r) => r.outcome === "skipped").length,
        failed:   results.filter((r) => r.outcome === "failed").length,
        auth_reconnect_required: authReconnectRequired,
        ...(authReconnectRequired ? { hint: "LinkedIn returned 401/403. Reconnect via /social/settings to refresh the token (and grant r_member_social if scope was added recently)." } : {}),
        results: results.map(({ isAuthError: _ignored, ...rest }) => rest),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } finally {
    await sql`SELECT pg_advisory_unlock(${ANALYTICS_ADVISORY_LOCK_KEY})`;
  }
});
