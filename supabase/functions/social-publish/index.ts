// Edge Function: social-publish
//
// Reads any approved drafts in social.drafts whose scheduled_for has passed,
// publishes them to the matching channel (LinkedIn personal first; company,
// Meta, TikTok follow the same shape), and marks each draft published or
// failed. Runs on a 15-min pg_cron schedule (migration 0032).
//
// Token reads go through social.get_oauth_access_token (migration 0031) — a
// SECURITY DEFINER allowlist helper. This function never reads vault directly.
//
// Scope (G.3 first ship):
//   - linkedin_personal channel only. Other channels (linkedin_company, meta_*,
//     tiktok) are not yet wired; drafts targeting them stay 'approved' and a
//     diagnostic note is logged. Each future channel adds a switch case.
//
// Auth: AUDIT_SHARED_SECRET via x-audit-key header (same pattern as
// netlify-leads-reconcile + netlify-forms-audit). Cron-triggered only.
//
// Concurrency safety:
//   - Function-level: pg_try_advisory_lock at entry. Two cron firings cannot
//     run the publish loop concurrently — the second early-exits cleanly.
//   - Row-level: every UPDATE that transitions a draft uses a compare-and-swap
//     guard (`WHERE id = ... AND status = 'approved'`) so even if the lock
//     mechanism fails, a draft can only be marked published once.
//
// Failure handling per the spec in admin-dashboard-scoping.md § Session G:
//   - 4xx (LinkedIn rejected the post): status='failed', publish_error set,
//     no retry. Surfaced in /social/drafts for owner review.
//   - 5xx / network: status stays 'approved', publish_error notes the
//     transient error. The next cron tick will retry naturally.
//   - 401 (expired token): mark social.oauth_tokens.expires_at = now() so
//     vw_channel_status flips to 'expired'. Draft stays 'approved' — no
//     retry until owner reconnects via /social/settings.
//   - 429 (rate limited): respect Retry-After, defer to next tick.

import postgres from "npm:postgres@3";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");

if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL not set (should be auto-injected by Supabase)");
}

const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 20, prepare: false });

// LinkedIn API version. LinkedIn deprecates after ~12 months — bump on a
// regular cadence (verify against api.linkedin.com docs before bumping; an
// unsupported version returns HTTP 426 NONEXISTENT_VERSION). 202401 and 202504
// both rejected 2026-04-27 — LinkedIn has aggressively pruned older versions.
// Trying current-month form.
const LINKEDIN_VERSION = "202604";
const LINKEDIN_MAX_COMMENTARY_CHARS = 3000;
const PUBLISH_BATCH_LIMIT = 10;

// Arbitrary 64-bit integer for the function-level advisory lock. Different
// from any other advisory lock in this project. Documented here so future
// crons / Edge Functions know not to reuse the value.
const PUBLISH_ADVISORY_LOCK_KEY = 8472639;

async function getAuditSharedSecret(): Promise<string> {
  const rows = await sql<Array<{ secret: string }>>`
    SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
  `;
  return rows[0].secret;
}

interface DraftRow {
  id: string;
  brand: string;
  channel: string;
  content: string;
  scheduled_for: string;
}

interface OAuthRow {
  external_account_id: string | null;
  expires_at: string | null;
}

interface PublishResult {
  draft_id: string;
  outcome: "published" | "failed" | "deferred";
  external_post_id?: string | null;
  error?: string;
}

// Post a single draft to LinkedIn personal profile.
async function publishLinkedInPersonal(
  content: string,
  externalAccountUrn: string,
  accessToken: string,
): Promise<
  | { ok: true; postId: string | null }
  | { ok: false; status: number; body: string; isTransient: boolean; isAuthExpired: boolean }
> {
  const body = {
    author: externalAccountUrn,
    commentary: content,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };

  const res = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "LinkedIn-Version": LINKEDIN_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 201 || res.status === 200) {
    const postId = res.headers.get("x-restli-id");
    return { ok: true, postId: postId && postId.length > 0 ? postId : null };
  }

  const errBody = await res.text().catch(() => "");
  const isAuthExpired = res.status === 401;
  const isTransient = res.status >= 500 || res.status === 429;
  return {
    ok: false,
    status: res.status,
    body: errBody.slice(0, 500),
    isTransient,
    isAuthExpired,
  };
}

async function processOneDraft(draft: DraftRow): Promise<PublishResult> {
  // Channel switch — only linkedin_personal in G.3 first ship. Unsupported
  // channels are marked 'failed' (rather than 'deferred') so they don't pile
  // up in the cron loop forever — owner can resubmit once the channel ships.
  if (draft.channel !== "linkedin_personal") {
    return {
      draft_id: draft.id,
      outcome: "failed",
      error: `Channel ${draft.channel} not yet implemented in social-publish.`,
    };
  }

  // Content length check (LinkedIn personal commentary cap).
  if (draft.content.length > LINKEDIN_MAX_COMMENTARY_CHARS) {
    return {
      draft_id: draft.id,
      outcome: "failed",
      error: `Content is ${draft.content.length} chars; LinkedIn personal cap is ${LINKEDIN_MAX_COMMENTARY_CHARS}.`,
    };
  }

  // Look up oauth_tokens row (for the URN).
  const tokenRows = await sql<OAuthRow[]>`
    SELECT external_account_id, expires_at
      FROM social.oauth_tokens
     WHERE brand = ${draft.brand} AND channel = ${draft.channel}
     LIMIT 1
  `;
  if (tokenRows.length === 0 || !tokenRows[0].external_account_id) {
    return {
      draft_id: draft.id,
      outcome: "failed",
      error: `No OAuth token / external_account_id for (${draft.brand}, ${draft.channel}). Connect via /social/settings.`,
    };
  }

  const externalAccountUrn = tokenRows[0].external_account_id!;

  // Read decrypted access_token via the SECURITY DEFINER helper.
  let accessToken: string | null = null;
  try {
    const tokenResult = await sql<Array<{ token: string | null }>>`
      SELECT social.get_oauth_access_token(${draft.brand}, ${draft.channel}) AS token
    `;
    accessToken = tokenResult[0]?.token ?? null;
  } catch (err) {
    return {
      draft_id: draft.id,
      outcome: "failed",
      error: `Token read failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
    };
  }
  if (!accessToken || accessToken.length === 0) {
    return {
      draft_id: draft.id,
      outcome: "failed",
      error: `Token read returned NULL/empty for (${draft.brand}, ${draft.channel}). Reconnect via /social/settings.`,
    };
  }

  // Publish.
  const result = await publishLinkedInPersonal(draft.content, externalAccountUrn, accessToken);

  if (result.ok) {
    if (!result.postId) {
      // LinkedIn returned 200/201 but no x-restli-id header. Treat as failure
      // rather than silently storing an empty post id and losing the reference.
      return {
        draft_id: draft.id,
        outcome: "failed",
        error: `LinkedIn returned success but no x-restli-id header. Post may have been created but URN is unknown — check the LinkedIn profile manually before re-publishing.`,
      };
    }
    return { draft_id: draft.id, outcome: "published", external_post_id: result.postId };
  }

  // 401 → mark token expired so /social/settings surfaces it. Draft stays
  // 'approved' so a reconnect-then-cron will retry.
  if (result.isAuthExpired) {
    await sql`
      UPDATE social.oauth_tokens
         SET expires_at = now()
       WHERE brand = ${draft.brand} AND channel = ${draft.channel}
    `;
    return {
      draft_id: draft.id,
      outcome: "deferred",
      error: `LinkedIn returned 401. Token marked expired. Reconnect via /social/settings.`,
    };
  }

  // 5xx / 429 → defer for the next cron tick. Draft stays 'approved'.
  if (result.isTransient) {
    return {
      draft_id: draft.id,
      outcome: "deferred",
      error: `LinkedIn returned ${result.status} (transient). Will retry next tick. Body: ${result.body}`,
    };
  }

  // 4xx → permanent fail. Draft moves to 'failed' for owner review.
  return {
    draft_id: draft.id,
    outcome: "failed",
    error: `LinkedIn ${result.status}: ${result.body}`,
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

  // Acquire function-level advisory lock. If another invocation is already
  // running the publish loop, exit cleanly — the next cron tick will pick
  // up whatever the running invocation hasn't claimed.
  const lockResult = await sql<Array<{ acquired: boolean }>>`
    SELECT pg_try_advisory_lock(${PUBLISH_ADVISORY_LOCK_KEY}) AS acquired
  `;
  if (!lockResult[0]?.acquired) {
    return new Response(
      JSON.stringify({
        checked_at: new Date().toISOString(),
        skipped: "another instance running",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  try {
    const drafts = await sql<DraftRow[]>`
      SELECT id::text, brand, channel, content, scheduled_for::text
        FROM social.drafts
       WHERE status = 'approved'
         AND scheduled_for <= now()
       ORDER BY scheduled_for ASC
       LIMIT ${PUBLISH_BATCH_LIMIT}
    `;

    const results: PublishResult[] = [];
    for (const draft of drafts) {
      const result = await processOneDraft(draft);
      results.push(result);

      // Apply the result with a compare-and-swap guard on status. If anything
      // else has already moved the draft (impossible under the advisory lock,
      // but belt-and-braces), the UPDATE is a no-op.
      if (result.outcome === "published") {
        await sql`
          UPDATE social.drafts
             SET status            = 'published',
                 external_post_id  = ${result.external_post_id ?? null},
                 published_at      = now(),
                 publish_error     = NULL,
                 updated_at        = now()
           WHERE id = ${draft.id}::uuid
             AND status = 'approved'
        `;
      } else if (result.outcome === "failed") {
        await sql`
          UPDATE social.drafts
             SET status         = 'failed',
                 publish_error  = ${result.error ?? "unknown error"},
                 updated_at     = now()
           WHERE id = ${draft.id}::uuid
             AND status = 'approved'
        `;
      } else {
        // deferred — leave status='approved' but record the last error.
        await sql`
          UPDATE social.drafts
             SET publish_error = ${result.error ?? null},
                 updated_at    = now()
           WHERE id = ${draft.id}::uuid
             AND status = 'approved'
        `;
      }
    }

    return new Response(
      JSON.stringify({
        checked_at: new Date().toISOString(),
        processed: results.length,
        published: results.filter((r) => r.outcome === "published").length,
        failed: results.filter((r) => r.outcome === "failed").length,
        deferred: results.filter((r) => r.outcome === "deferred").length,
        results,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  } finally {
    await sql`SELECT pg_advisory_unlock(${PUBLISH_ADVISORY_LOCK_KEY})`;
  }
});
