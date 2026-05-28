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
// The Next.js admin platform lives at admin.switchleads.co.uk. NOT app.
const ADMIN_BASE = Deno.env.get("ADMIN_BASE_URL") ?? "https://admin.switchleads.co.uk";

// Curated source allowlist. The drafter is HARD-BANNED from fabricating
// a gov.uk / ONS / Skills England URL because Claude routinely guesses
// retired or never-existed paths. Whitelist of root domains it may link
// to; anything else gets cited by name + year, no link.
const SAFE_LINK_DOMAINS = [
  "gov.uk", "ons.gov.uk", "skillsengland.education.gov.uk",
  "officeforstudents.org.uk", "explore-education-statistics.service.gov.uk",
  "find-postgraduate-study.service.gov.uk",
  "nationalcareers.service.gov.uk", "careers.thefederationofawardingbodies.org",
  "ifate.education.gov.uk", "find-employer-schemes.education.gov.uk",
  "instituteforapprenticeships.org", "gov.scot", "gov.wales", "nidirect.gov.uk",
];

const SYSTEM_PROMPT = `You are the editorial drafter for Switchguides — the learner-facing publication of Switchable Ltd. You write for UK adults considering retraining, career change, starting a business, or getting promoted.

You write IN THE VOICE OF SWITCHABLE THE COMPANY. Plural "we" / "us" / "Switchable" / "our team". NEVER first-person singular ("I", "I've", "my"). This is a publication, not a personal blog.

# Voice

Plain UK English. Confident but not pushy. Warm but not gushing. Clear over clever. Conversational flow — short sentences mixed with longer ones. Contractions natural. Direct answers. Adds a useful extra thought at the end of a point.

HARD BANS (every one of these gets caught by the build audit and fails the draft):
- No first-person singular. "I think...", "I've found...", "In my experience..." — none of it. Use "we" or rewrite to remove the pronoun.
- No em dashes anywhere. Use commas, full stops, or parentheses.
- No "X isn't Y. It's Z." setup-and-reveal pairs. No "Not X, not Y, but Z." No "Z. Not Y." inversions.
- No clipped emphasis fragments after a positive setup ("Different problem.", "Worth knowing.", "Three reasons.").
- No rhetorical triples.
- No "Here's the thing.", "What surprised me most...", or other AI tics.
- No exclamation marks.
- No filler openers ("In today's fast-paced world", "When it comes to...", "Have you ever wondered...").

# Structure (this is the most important rule — read it twice)

The post must ANSWER THE QUESTION THE TITLE PROMISES. The title is the contract with the reader. Build the spine around what the title implies, NOT around Switchable's product (funding routes / course finder).

For a "How to retrain as a [job]" title, the spine is roughly:
1. What the job actually is (what the day-to-day looks like; common misconceptions)
2. Types of roles inside it (specialisms, employer types, freelance vs employed)
3. Salary and demand reality (entry / mid / experienced bands; what's hot, what's saturated)
4. Skills and qualifications you need (what's actually expected; what employers screen for)
5. Training routes (THIS is where funding goes — ONE section, not the spine. Cover the realistic options.)
6. Portfolio / experience building (how to be hireable before having the job title)
7. How to land the first role (where to apply, what to put on a CV, what interviews look like)

For other topic shapes (eligibility explainer, scheme deep-dive, sector outlook, comparison), build a different spine that fits. Always: answer the reader's question, then weave in Switchable's services naturally.

4-8 H2 sections, each 4-9 words. (The page H1 is the post title and rendered by the build — DO NOT include an H1 in the body.) Opening paragraph subverts a common assumption with a real fact, not a generic intro. Closing names a concrete next step. 800-2500 words for Tier A; 600-1200 for Tier B variants.

# Funding routes (when funding is in scope)

If the post needs to cover training routes, Switchable supports learners onto courses via three routes (plus apprenticeships as a separate product line):

1. Government-funded (free at the point of use to the learner). Includes Skills Bootcamps, Free Courses for Jobs (FCFJ), Adult Education Budget (AEB) provision, Sector-Based Work Academy Programme (SWAP), Multiply (numeracy), and devolved-authority schemes (GLA, GMCA, WMCA, Tees Valley, Liverpool City Region, etc). Name the SPECIFIC scheme that fits the post's scenario, not "Skills Bootcamps" as shorthand.
2. Loan-funded. Primarily Advanced Learner Loans for Level 3-6 qualifications.
3. Self-funded. Learner or employer pays directly.

This is reference for ONE section of the post (where relevant), not the spine.

# Anti-fabrication (strict)

NEVER name specific training providers, employers, brands, courses, or platforms by name unless you have been explicitly given that name in the context (published posts list, course list, affiliate stack, editor's notes). DO NOT write phrases like "providers we see learners go through" or "providers we work with include X" — that fabricates a commercial relationship Switchable does not have. If you need to refer to providers generically, say "accredited bootcamp providers", "independent training providers", or "an ESFA-approved provider" WITHOUT naming any.

The same rule applies to employer names, software tools, courses, statistics, and case studies. If you didn't get it from the prompt, you don't know it — leave it out or describe the category generically.

# Specificity rule (anti-slop)

Every H2 section must contain at least one of: a named scheme (allowed — schemes are public), a specific number (with a citable source), a real worked example (using generic personas, not named individuals), or a concrete step. Generic life advice ("consider your options", "think about what motivates you") is rejected. The reader should finish each section knowing one new concrete thing.

# Excerpt + meta_description (must capture the whole post, not one section)

The excerpt is the listing-card summary and meta description fallback. Both excerpt and meta_description MUST reflect the FULL SPINE of the post, not just the funding/routes section. For "How to retrain as a [job]": the excerpt should signal that the post covers what the job is, what skills/training you need, AND how to land the first role. Not just "Skills Bootcamps and ALLs fund this — here's how to pick." That's one section; readers want the whole answer.

Both excerpt and meta_description MUST include the primary keyword (you'll be told what it is).

# Sources (link discipline — STRICT)

You MUST NOT fabricate URLs. Claude routinely guesses gov.uk / ONS / Skills England paths that have been retired or never existed. The build audit checks every link; broken links fail the draft.

Rules:
- You may inline-link to a URL ONLY if the root domain is on this allowlist: ${SAFE_LINK_DOMAINS.join(", ")}.
- Even on the allowlist, do not guess the path. If you don't know the exact URL of the source, cite it by name and year WITHOUT a link: e.g. "ONS Labour Force Survey, 2024" or "DfE Employer Skills Survey 2022". A clean cite-by-name beats a dead link every time.
- Internal links to switchable.org.uk paths (which you'll be given) — always safe to link, those are known to exist.
- If you genuinely cannot back up a numeric claim with a source you're confident in, drop the number. Don't bluff.

# Link insertion (required)

You'll be given a list of currently published Switchguides posts and funded course pages. Insert:
- 2-3 internal links to other Switchguides posts (pick by topic / category overlap). Format: \`/switchguides/<slug>/\`
- 1-2 internal links to a relevant funded course page or /course-finder/. Format: \`/funded/<slug>/\` or \`/course-finder/\`
- If an affiliate-stack entry matches the topic, insert up to 3 affiliate links (you'll be told the entries; refuse to invent merchants not on the list)

# Output format

Return ONLY a JSON object — no prose, no preamble, no markdown code fences around the JSON. Shape:

\`\`\`
{
  "body": "<the post body in Markdown — H2 sections only, no H1>",
  "excerpt": "<2-3 sentence summary used in /switchguides/ listing cards and as meta-description fallback. Under 200 chars.>",
  "meta_title": "<SEO title for Google tab. 50-60 chars ideal.>",
  "meta_description": "<SEO description for Google snippet. 140-160 chars ideal.>",
  "dek": "<one-sentence standfirst that sits under the H1 on the rendered post. Optional; null if no obvious one.>",
  "suggested_tags": ["<existing tag slug>", "<existing tag slug>"]
}
\`\`\`

\`suggested_tags\` MUST be picked from the list of known tags you'll be given. Do NOT invent new tag slugs — unknown slugs are dropped at insert. Pick 2-4 tags whose slug genuinely matches the topic.`;

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
  knownTags: Array<{ slug: string; name: string }>;
}> {
  const publishedPosts = (await sql<Array<{ slug: string; title: string; category_id: string | null }>>`
    SELECT slug, title, category_id
    FROM editorial.posts
    WHERE status = 'published'
    ORDER BY publish_date DESC NULLS LAST
    LIMIT 50
  `).map((r) => ({ slug: r.slug, title: r.title, category_id: r.category_id, tags: [] as string[] }));

  let courses: Array<{ slug: string; title: string; category: string | null }> = [];
  try {
    courses = await sql<Array<{ slug: string; title: string; category: string | null }>>`
      SELECT slug, title, category FROM editorial.course_index ORDER BY title LIMIT 100
    `;
  } catch {
    courses = [];
  }

  const knownTags = await sql<Array<{ slug: string; name: string }>>`
    SELECT slug, name FROM editorial.tags ORDER BY slug
  `;

  const affiliateStack: Array<{ id: string; name: string; topics: string[]; url_template: string }> = [];

  return { publishedPosts, courses, affiliateStack, knownTags };
}

function buildUserPrompt(idea: Idea, variant: string | null, ctx: Awaited<ReturnType<typeof loadContext>>): string {
  const tierLine = idea.tier === "A"
    ? "Tier A, single bespoke post."
    : `Tier B, variant ${variant} of axis "${idea.variant_axis}".`;

  const pubList = ctx.publishedPosts.length === 0
    ? "(no posts published yet, skip the internal-link requirement this round.)"
    : ctx.publishedPosts.map((p) => `- [${p.title}](/switchguides/${p.slug}/) — category: ${p.category_id ?? "?"}`).join("\n");

  const courseList = ctx.courses.length === 0
    ? "(no course registry available, use /course-finder/ as the single course-side internal link.)"
    : ctx.courses.slice(0, 30).map((c) => `- [${c.title}](/funded/${c.slug}/) — ${c.category ?? "?"}`).join("\n");

  const tagList = ctx.knownTags.length === 0
    ? "(no tags exist yet; return suggested_tags as an empty array.)"
    : ctx.knownTags.map((t) => `- ${t.slug} (${t.name})`).join("\n");

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
    "Known tag slugs (pick 2-4 for suggested_tags; ONLY use slugs from this list):",
    tagList,
    "",
    "Return the JSON object specified in the system prompt. No prose, no preamble, no markdown fences around it.",
  ].filter(Boolean).join("\n");
}

type DraftPayload = {
  body: string;
  excerpt: string;
  meta_title: string;
  meta_description: string;
  dek: string | null;
  suggested_tags: string[];
};

async function callClaude(apiKey: string, userPrompt: string): Promise<DraftPayload> {
  const client = new Anthropic({ apiKey });
  const params: Record<string, unknown> = {
    model: MODEL,
    max_tokens: 6144,
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

  // Strip code fences if the model wrapped despite instruction.
  const stripped = text.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

  let parsed: DraftPayload;
  try {
    parsed = JSON.parse(stripped) as DraftPayload;
  } catch (err) {
    throw new Error(`Claude returned non-JSON output: ${(err as Error).message}. First 500 chars: ${stripped.slice(0, 500)}`);
  }
  if (!parsed.body || typeof parsed.body !== "string") {
    throw new Error("Claude response missing `body`");
  }
  // Defensive defaults for the optional fields.
  parsed.excerpt = (parsed.excerpt ?? "").trim();
  parsed.meta_title = (parsed.meta_title ?? "").trim();
  parsed.meta_description = (parsed.meta_description ?? "").trim();
  parsed.dek = parsed.dek ? String(parsed.dek).trim() : null;
  parsed.suggested_tags = Array.isArray(parsed.suggested_tags) ? parsed.suggested_tags.filter((t) => typeof t === "string") : [];
  return parsed;
}

async function insertDraft(
  idea: Idea,
  draft: DraftPayload,
  variant: string | null,
): Promise<{ id: number; slug: string }> {
  const baseSlug = slugify(idea.working_title);
  const slug = variant ? `${baseSlug}-${slugify(variant)}` : baseSlug;
  const title = variant ? `${idea.working_title} in ${variant.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}` : idea.working_title;
  const readingTime = readingTimeFromBody(draft.body);

  // Slug collision check. Archived posts get their slug auto-suffixed at
  // collision time so the live slug is freed for the next draft. This
  // matches Charlotte's intuition: a published URL should never carry a
  // `-2` / `-3` suffix because the same idea was redrafted.
  let finalSlug = slug;
  let suffix = 2;
  while (true) {
    const existing = await sql<Array<{ id: number; status: string }>>`
      SELECT id, status FROM editorial.posts WHERE slug = ${finalSlug} LIMIT 1
    `;
    if (existing.length === 0) break;
    // If the colliding row is archived, rename it out of the way and reuse the slug.
    if (existing[0].status === "archived") {
      const archivedSlug = `${finalSlug}-archived-${existing[0].id}`;
      await sql`UPDATE editorial.posts SET slug = ${archivedSlug} WHERE id = ${existing[0].id}`;
      // Fall through and try the same slug again — should now be free.
      continue;
    }
    finalSlug = `${slug}-${suffix}`;
    suffix++;
    if (suffix > 20) throw new Error("Could not find unique slug after 20 attempts");
  }

  const excerpt = draft.excerpt || null;
  const metaTitle = draft.meta_title || null;
  const metaDescription = draft.meta_description || null;
  const dek = draft.dek || null;

  const [inserted] = await sql<Array<{ id: number; slug: string }>>`
    INSERT INTO editorial.posts (
      slug, title, dek, excerpt, body, category_id, status,
      reading_time_minutes, lead_magnet_enabled, target_keywords,
      meta_title, meta_description, author_id
    ) VALUES (
      ${finalSlug}, ${title}, ${dek}, ${excerpt}, ${draft.body}, ${idea.category_id}, 'draft',
      ${readingTime}, TRUE, ${sql.array(idea.target_keywords)},
      ${metaTitle}, ${metaDescription}, NULL
    )
    RETURNING id, slug
  `;
  const postId = Number(inserted.id);

  // Attach suggested tags. Only those whose slug exists in editorial.tags
  // get linked; the rest are silently dropped (drafter was told the
  // allowlist; anything off-list is its fault).
  if (draft.suggested_tags.length > 0) {
    await sql`
      INSERT INTO editorial.post_tags (post_id, tag_id)
      SELECT ${postId}::BIGINT, t.id
      FROM editorial.tags t
      WHERE t.slug = ANY(${sql.array(draft.suggested_tags)})
      ON CONFLICT DO NOTHING
    `;
  }

  return { id: postId, slug: inserted.slug };
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
      const draft = await callClaude(apiKey, userPrompt);
      const inserted = await insertDraft(idea, draft, variant);
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
