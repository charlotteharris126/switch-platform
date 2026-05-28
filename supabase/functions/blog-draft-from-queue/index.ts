// Edge Function: blog-draft-from-queue
//
// Runs on a pg_cron schedule (Mon/Wed/Fri 09:00 UK = 08:00/09:00 UTC
// depending on BST). Picks the next status='queued' row from
// editorial.post_ideas where proposed_publish_date <= today + 3 days,
// drafts the post via Claude API using the rules from
// .claude/rules/editorial-rules.md, inserts as status='draft' in
// editorial.posts, flips the post_idea row to status='drafted', and
// emails Charlotte a Brevo notification.
//
// Tier handling:
//   - Tier A: one master draft.
//   - Tier B: one master draft + N variant fan-outs (one per `variants`
//     entry). All grouped in editorial.draft_batches. One email per
//     batch (not per variant — Charlotte spot-checks the master + 2
//     randoms then approves the whole batch).
//   - Tier C: skipped by this EF. Service pages are built deterministically
//     from data/courses YAML + data/funded-regions YAML by the site
//     build script, not drafted.
//
// Auth: x-audit-key header (same as blog-ai-assist + admin-brevo-resync).
// Backlog guard: refuses to pick if there are more than 5 drafted posts
// awaiting proof — Charlotte's bottleneck is proofing, don't pile on.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import Anthropic from "npm:@anthropic-ai/sdk@0.65.0";
import { sendBrevoEmail } from "../_shared/brevo.ts";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
const MODEL = "claude-opus-4-7";

// Backlog cap — proofing bottleneck protection per editorial-rules §6.
const PROOF_BACKLOG_CAP = 5;

// Brevo notification recipient — Charlotte's editor inbox. Hardcoded
// because the queue drafter is only invoked when there's something for
// her to proof; no chance the recipient varies.
const NOTIFY_TO_EMAIL = Deno.env.get("EDITORIAL_NOTIFY_EMAIL") ?? "hello@switchable.careers";

// Admin app base URL — used in the Brevo email's "open draft" link.
const ADMIN_BASE = Deno.env.get("ADMIN_BASE_URL") ?? "https://app.switchleads.co.uk";

const SYSTEM_PROMPT = `You are the editorial drafter for Switchguides, the learner-facing publication of Switchable Ltd. You write blog posts in Charlotte Harris's voice for UK adults considering retraining, career change, business starts, or career progression.

The editorial rules are in .claude/rules/editorial-rules.md. The voice rules are in .claude/rules/copy.md and .claude/rules/charlotte-voice.md. The audience + business context is in .claude/rules/business.md. You have those rules in your prompt; you do not need to invent.

# Voice (Charlotte's; strict)

Plain UK English. Confident but not pushy. Conversational flow — short sentences mixed with longer ones, never stiff. Direct answers but leaves room for dialogue. Uses contractions naturally. Adds a useful extra thought at the end of a point.

HARD BANS:
- No em dashes anywhere. Use commas, full stops, or parentheses.
- No "X isn't Y. It's Z." setup-and-reveal pairs. No "Not X, not Y, but Z." No "Z. Not Y." inversions.
- No clipped emphasis fragments after a positive setup ("Different problem.", "Worth knowing.", "Three reasons.").
- No rhetorical triples.
- No "Here's the thing.", "What surprised me most...", or other AI tics.
- No exclamation marks.
- No filler openers ("In today's fast-paced world", "When it comes to...", "Have you ever wondered...").

# Structure

Exactly one H1 (the title). 4-8 H2 sections, each 4-9 words. Opening paragraph subverts a common assumption with a real fact, not a generic intro. Closing names a concrete next step (course finder, specific tool, sign-up). 800-2500 words for Tier A; 600-1200 for Tier B variants.

# Sources

Every numeric claim has an inline source link to gov.uk / ONS / official UK source. Format: \`[claim](https://source.url/path)\`. No claim without a source.

# Link insertion (required)

You will be given the list of currently published Switchguides posts and a list of funded course pages. Insert:
- 2-3 internal links to other Switchguides posts (pick by topic / tag overlap)
- 1-2 internal links to a relevant funded course page or /course-finder/
- If an affiliate-stack entry matches the topic, insert up to 3 affiliate links (you'll be told the entries; refuse to invent merchants not on the list)
- If a lead-magnet matches the topic, insert one inline

# Format

Return ONLY the post body in Markdown. No frontmatter, no preamble, no commentary. Start with an H2 (not the H1 — the H1 lives in the post title field elsewhere). End with the call-to-action paragraph.

Do not return a JSON wrapper or any explanation — pure Markdown body only.`;

type Idea = {
  id: number;
  slug: string | null;
  working_title: string;
  category_id: string | null;
  primary_keyword: string | null;
  target_keywords: string[];
  proposed_publish_date: string | null;
  notes: string | null;
  tier: "A" | "B" | "C";
  variant_axis: string | null;
  variants: string[];
};

type PublishedSummary = {
  slug: string;
  title: string;
  category_id: string | null;
  tags: string[];
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 75);
}

function readingTimeFromBody(body: string): number {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function getVaultSecret(name: string): Promise<string | null> {
  try {
    const rows = await sql<Array<{ secret: string }>>`
      SELECT public.get_shared_secret(${name}) AS secret
    `;
    return rows[0]?.secret ?? null;
  } catch (err) {
    console.error(`vault secret ${name} fetch failed:`, String(err));
    return null;
  }
}

async function loadContext(): Promise<{
  publishedPosts: PublishedSummary[];
  courses: Array<{ slug: string; title: string; category: string | null }>;
  affiliateStack: Array<{ id: string; name: string; topics: string[]; url_template: string }>;
}> {
  const publishedPosts = (await sql<Array<{ slug: string; title: string; category_id: string | null }>>`
    SELECT slug, title, category_id
    FROM editorial.posts
    WHERE status = 'published'
    ORDER BY publish_date DESC NULLS LAST
    LIMIT 50
  `).map((r) => ({ slug: r.slug, title: r.title, category_id: r.category_id, tags: [] as string[] }));

  // Course list — pulled from crm.providers + their YAML manifest would be cleaner,
  // but the canonical list lives in switchable/site/deploy/data/courses/*.yml which
  // isn't accessible from the EF runtime. For v1, query a simple registry view if
  // it exists, else empty list (drafter falls back to /course-finder/ as the only
  // course-side internal link).
  let courses: Array<{ slug: string; title: string; category: string | null }> = [];
  try {
    courses = await sql<Array<{ slug: string; title: string; category: string | null }>>`
      SELECT slug, title, category FROM editorial.course_index ORDER BY title LIMIT 100
    `;
  } catch {
    courses = [];
  }

  // Affiliate stack — same — lives in YAML on the site repo. Drafter for v1
  // skips affiliate insertion unless the queue row's notes explicitly name one.
  const affiliateStack: Array<{ id: string; name: string; topics: string[]; url_template: string }> = [];

  return { publishedPosts, courses, affiliateStack };
}

function buildUserPrompt(idea: Idea, variant: string | null, ctx: Awaited<ReturnType<typeof loadContext>>): string {
  const tierLine = idea.tier === "A"
    ? "Tier A — single bespoke post."
    : `Tier B — variant ${variant} of axis "${idea.variant_axis}".`;

  const pubList = ctx.publishedPosts.length === 0
    ? "(no posts published yet — skip the internal-link requirement this round; surface that in the output)"
    : ctx.publishedPosts.map((p) => `- [${p.title}](/switchguides/${p.slug}/) — category: ${p.category_id ?? "?"}`).join("\n");

  const courseList = ctx.courses.length === 0
    ? "(no course registry available — use /course-finder/ as the single internal link)"
    : ctx.courses.slice(0, 30).map((c) => `- [${c.title}](/funded/${c.slug}/) — ${c.category ?? "?"}`).join("\n");

  return [
    `Topic: ${idea.working_title}${variant ? ` (for ${variant})` : ""}`,
    `Primary keyword: ${idea.primary_keyword ?? "(none specified)"}`,
    `Category: ${idea.category_id ?? "(none)"}`,
    `Target keywords: ${idea.target_keywords.join(", ") || "(none)"}`,
    `${tierLine}`,
    idea.notes ? `Editor's notes: ${idea.notes}` : "",
    "",
    "Currently published Switchguides posts (link 2-3 of these where relevant):",
    pubList,
    "",
    "Funded course pages (link 1-2 of these where relevant; otherwise link /course-finder/):",
    courseList,
    "",
    "Draft the post body in Markdown per the system prompt rules. Pure Markdown body only — no frontmatter, no commentary, no JSON wrapper.",
  ].filter(Boolean).join("\n");
}

async function callClaude(apiKey: string, userPrompt: string): Promise<string> {
  const client = new Anthropic({ apiKey });
  const params: Record<string, unknown> = {
    model: MODEL,
    max_tokens: 4096,
    output_config: { effort: "high" },
    cache_control: { type: "ephemeral" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  };
  const response = await client.messages.create(params as never);
  let text = "";
  for (const block of response.content as Array<Record<string, unknown>>) {
    if (block.type === "text" && typeof block.text === "string") text += block.text;
  }
  if (!text.trim()) throw new Error("Empty response from Claude");
  return text.trim();
}

async function insertDraft(
  idea: Idea,
  body: string,
  variant: string | null,
): Promise<{ id: number; slug: string }> {
  const baseSlug = slugify(idea.working_title);
  const slug = variant ? `${baseSlug}-${slugify(variant)}` : baseSlug;
  const title = variant ? `${idea.working_title} in ${variant.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}` : idea.working_title;
  const readingTime = readingTimeFromBody(body);

  // Slug collision check — append -2, -3 if needed.
  let finalSlug = slug;
  let suffix = 2;
  while (true) {
    const existing = await sql<Array<{ id: number }>>`
      SELECT id FROM editorial.posts WHERE slug = ${finalSlug} LIMIT 1
    `;
    if (existing.length === 0) break;
    finalSlug = `${slug}-${suffix}`;
    suffix++;
    if (suffix > 20) throw new Error("Could not find unique slug after 20 attempts");
  }

  const [inserted] = await sql<Array<{ id: number; slug: string }>>`
    INSERT INTO editorial.posts (
      slug, title, body, category_id, status,
      reading_time_minutes, lead_magnet_enabled, target_keywords, author_id
    ) VALUES (
      ${finalSlug}, ${title}, ${body}, ${idea.category_id}, 'draft',
      ${readingTime}, TRUE, ${sql.array(idea.target_keywords)}, NULL
    )
    RETURNING id, slug
  `;
  return { id: Number(inserted.id), slug: inserted.slug };
}

async function notifyCharlotte(args: {
  ideaTitle: string;
  tier: "A" | "B";
  posts: Array<{ slug: string; title: string }>;
}): Promise<void> {
  const isBatch = args.tier === "B" && args.posts.length > 1;
  const subject = isBatch
    ? `Drafted: ${args.ideaTitle} (${args.posts.length} variants)`
    : `Drafted: ${args.ideaTitle}`;

  const masterLink = `${ADMIN_BASE}/admin/blog/${args.posts[0].slug}/edit`;
  const itemsHtml = args.posts
    .slice(0, 8)
    .map((p) => `<li><a href="${ADMIN_BASE}/admin/blog/${p.slug}/edit">${p.title}</a></li>`)
    .join("");

  const html = `
    <p>Sasha just drafted ${isBatch ? `<strong>${args.posts.length} variants</strong> of` : "a new post:"} <strong>${args.ideaTitle}</strong>.</p>
    ${isBatch ? `<p>Spot-check the master + 2 randoms, then approve the batch.</p>` : ""}
    <ul>${itemsHtml}</ul>
    ${args.posts.length > 8 ? `<p>+ ${args.posts.length - 8} more. <a href="${ADMIN_BASE}/admin/blog">See all in admin</a>.</p>` : ""}
    <p><a href="${masterLink}">Open ${isBatch ? "the master" : "the draft"} →</a></p>
    <p style="font-size:12px;color:#5a6a72;margin-top:24px">Pipeline: <a href="${ADMIN_BASE}/admin/blog/content-plan">/admin/blog/content-plan</a>. Auto-drafter runs Mon/Wed/Fri 09:00 UK.</p>
  `;

  await sendBrevoEmail({
    to: [{ email: NOTIFY_TO_EMAIL, name: "Editor" }],
    subject,
    htmlContent: html,
    tags: ["editorial-drafter", `tier-${args.tier.toLowerCase()}`],
    brand: "switchable",
  });
}

serve(async (req) => {
  if (req.method !== "POST") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }

  // Auth via DB vault (same pattern as blog-ai-assist).
  const auditKey = req.headers.get("x-audit-key");
  const expected = await getVaultSecret("AUDIT_SHARED_SECRET");
  if (!expected) return json({ ok: false, error: "AUDIT_SHARED_SECRET not in vault" }, 500);
  if (!auditKey || auditKey !== expected) return json({ ok: false, error: "unauthorised" }, 401);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, 500);

  // Backlog guard. If too many drafted posts await proof, pause queue picking.
  const [{ pending_proof_count }] = await sql<Array<{ pending_proof_count: number }>>`
    SELECT count(*)::INT AS pending_proof_count
    FROM editorial.posts
    WHERE status = 'draft'
      AND created_at > NOW() - INTERVAL '90 days'
  `;
  if (Number(pending_proof_count) >= PROOF_BACKLOG_CAP) {
    return json({
      ok: true,
      action: "skipped",
      reason: `${pending_proof_count} drafts pending proof (cap ${PROOF_BACKLOG_CAP}). Clear backlog before queue resumes.`,
    });
  }

  // Pick the next queued idea (not C tier — those are programmatic).
  const ideas = await sql<Idea[]>`
    SELECT id, slug, working_title, category_id, primary_keyword, target_keywords,
           TO_CHAR(proposed_publish_date, 'YYYY-MM-DD') AS proposed_publish_date,
           notes, tier, variant_axis, variants
    FROM editorial.post_ideas
    WHERE status = 'queued'
      AND tier IN ('A', 'B')
      AND (proposed_publish_date IS NULL OR proposed_publish_date <= CURRENT_DATE + INTERVAL '3 days')
    ORDER BY proposed_publish_date ASC NULLS LAST, sort_order ASC, id ASC
    LIMIT 1
  `;

  if (ideas.length === 0) {
    return json({ ok: true, action: "skipped", reason: "no queued ideas due in the next 3 days" });
  }

  const idea = ideas[0];
  const ctx = await loadContext();

  const startedAt = Date.now();
  const draftedPosts: Array<{ id: number; slug: string; title: string }> = [];
  const failures: Array<{ variant: string | null; error: string }> = [];

  // Open a draft_batches row up front so partial failures still leave a record.
  const [batch] = await sql<Array<{ id: number }>>`
    INSERT INTO editorial.draft_batches (post_idea_id, tier, total_count, status)
    VALUES (${idea.id}, ${idea.tier}, ${idea.tier === "B" ? idea.variants.length : 1}, 'drafting')
    RETURNING id
  `;
  const batchId = Number(batch.id);

  const targets: Array<string | null> = idea.tier === "B" ? idea.variants : [null];

  for (const variant of targets) {
    try {
      const userPrompt = buildUserPrompt(idea, variant, ctx);
      const body = await callClaude(apiKey, userPrompt);
      const inserted = await insertDraft(idea, body, variant);
      draftedPosts.push({ id: inserted.id, slug: inserted.slug, title: idea.working_title + (variant ? ` (${variant})` : "") });
      // Track progress on the batch row.
      await sql`
        UPDATE editorial.draft_batches
        SET drafted_count = drafted_count + 1,
            ${batchId ? sql`variant_post_ids = array_append(variant_post_ids, ${inserted.id}::BIGINT)` : sql`master_post_id = ${inserted.id}::BIGINT`}
        WHERE id = ${batchId}
      `;
      // Master post on Tier B = first variant.
      if (variant === targets[0]) {
        await sql`UPDATE editorial.draft_batches SET master_post_id = ${inserted.id}::BIGINT WHERE id = ${batchId} AND master_post_id IS NULL`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`drafter failed for variant=${variant}:`, msg);
      failures.push({ variant, error: msg });
      await sql`
        UPDATE editorial.draft_batches
        SET failed_count = failed_count + 1,
            error_log = error_log || ${JSON.stringify({ variant, error: msg, at: new Date().toISOString() })}::JSONB
        WHERE id = ${batchId}
      `;
    }
  }

  // Close the batch.
  await sql`
    UPDATE editorial.draft_batches
    SET status = 'awaiting_proof', completed_at = NOW()
    WHERE id = ${batchId}
  `;

  // Flip the post_ideas row.
  if (draftedPosts.length > 0) {
    await sql`
      UPDATE editorial.post_ideas
      SET status = 'drafted', slug = ${draftedPosts[0].slug}, updated_at = NOW()
      WHERE id = ${idea.id}
    `;

    // Notify Charlotte.
    try {
      await notifyCharlotte({
        ideaTitle: idea.working_title,
        tier: idea.tier as "A" | "B",
        posts: draftedPosts,
      });
    } catch (err) {
      console.error("Brevo notify failed (non-blocking):", err);
    }
  }

  return json({
    ok: true,
    action: "drafted",
    idea_id: idea.id,
    batch_id: batchId,
    tier: idea.tier,
    drafted_count: draftedPosts.length,
    failed_count: failures.length,
    drafted_posts: draftedPosts.map((p) => ({ id: p.id, slug: p.slug })),
    failures,
    elapsed_ms: Date.now() - startedAt,
  });
});
