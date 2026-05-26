// Edge Function: blog-ai-assist
//
// AI-assist suggestions for the /admin/blog editor. Five surfaces invoked
// from "Suggest" buttons next to the relevant field:
//   - outline           markdown H2 list
//   - headlines         5 title variants
//   - meta_description  ~150-char SERP snippet
//   - excerpt           2-3 sentence listing summary
//   - tags              suggested slugs from the existing tag registry
//
// Auth: x-audit-key header (mirrors admin-brevo-resync, run-024 panels).
// Cost log: writes one row to editorial.ai_assist_log per call (success or
// failure) so Charlotte can see per-surface usage + USD cost trend.
//
// Architecture:
//   - System prompt carries the (large, stable) brand + voice + audience
//     context — same across every call, so it caches between calls.
//     Top-level cache_control auto-places on the last cacheable block.
//   - User prompt carries the kind-specific instructions + per-call post
//     content. Tiny, doesn't cache.
//   - Model: claude-opus-4-7 per the claude-api skill default. Thinking off
//     (Opus 4.7 default), effort medium (good cost/quality balance for short
//     generation tasks; high would over-spend tokens on a single tagline).
//   - max_tokens 1024 across all surfaces (the largest output is ~500 toks
//     for the outline).
//   - Structured outputs (json_schema) for headlines + tags so the panel can
//     trust the response shape. Plain text for the prose surfaces.
//
// Cost pricing (claude-opus-4-7, 2026-05-25):
//   Input:           $5.00 / M tokens
//   Output:          $25.00 / M tokens
//   Cache creation:  $6.25 / M tokens (1.25× input, 5-min TTL)
//   Cache read:      $0.50 / M tokens (0.10× input)
//   System prompt designed to be ≥ 4096 tokens (Opus 4.7 cache minimum) so
//   the first call writes once, every subsequent call within 5 min reads.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
// Pin to a known-working SDK version (the unversioned form let the Edge
// runtime cache an older copy that didn't know about output_config /
// json_schema, which is the most likely silent-failure path for the
// previous deploy). Update as new SDK versions land + are tested.
import Anthropic from "npm:@anthropic-ai/sdk@0.65.0";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });

const MODEL = "claude-opus-4-7";

// Pricing constants in USD per million tokens. Update if Anthropic pricing
// shifts; the assist_log stores cost_usd at call time so historical rows
// stay accurate even if these change.
const PRICE_INPUT_PER_M           = 5.00;
const PRICE_OUTPUT_PER_M          = 25.00;
const PRICE_CACHE_CREATION_PER_M  = 6.25;
const PRICE_CACHE_READ_PER_M      = 0.50;

type Kind = "outline" | "headlines" | "meta_description" | "excerpt" | "tags";

interface PostInput {
  title?: string;
  dek?: string | null;
  excerpt?: string | null;
  body?: string;
  category_id?: string | null;
  target_keywords?: string[];
  current_value?: string;        // current value of the field being suggested for; informs "improve this" framing
}

interface AssistRequest {
  kind: Kind;
  post: PostInput;
  post_id?: number | null;       // for cost log; null in create mode
  post_slug?: string | null;
  known_tags?: Array<{ slug: string; name: string }>;
}

const SYSTEM_PROMPT = `You are the editorial AI assistant for Switchable, a UK lead-generation business helping adults find funded training and career-change support. You assist Charlotte (the founder) inside the in-house CMS as she drafts blog posts. Your job is to suggest copy that sounds like her voice — never to produce filler that needs to be rewritten.

# Who Switchable serves

UK adults 19+, residents, not in full-time education. Considering a career change, upskilling, or returning to work. Often unaware that funded training options exist. Wary of being sold to — trust is a barrier. Tone they respond to: approachable, motivating, real, never patronising.

Three funding routes the blog covers:
- Free Courses for Jobs (FCFJ) — first full Level 3 qualification, free for adults 24+ on low income or out of work.
- Skills Bootcamps — 12-16 week intensives, funded by DfE, adults 19+, full-time-work-compatible (evenings/weekends), guaranteed interview at end.
- Advanced Learner Loans — government-backed loans for Level 3-6 qualifications, no repayment until you earn over £25K, no credit check.
Plus Apprenticeships (rolling intake, any age 16+, levy-funded) and combined-authority regional pots.

Audience headline statistic: 81.3% of eligible UK adults have never heard of funded training before being reached. The brand's job is to bridge that gap with plain, useful guides.

# Voice rules (Charlotte's writing voice — strict)

Charlotte writes like a sharp, plain-spoken human:
- Confident but not pushy.
- Warm but not gushing.
- Conversational flow — short sentences mixed with longer ones, never stiff.
- Direct answers but leaves room for dialogue.
- Uses contractions naturally: "we'll", "it's", "there's", "don't".
- Adds a useful extra thought at the end of a point instead of stopping cold.

HARD BANS — never produce any of these:
- Em dashes ANYWHERE. Use commas, full stops, or parentheses. Rewrite the sentence if needed.
- AI rhetorical patterns: "X isn't Y. It's Z." setup-and-reveal pairs. Also "Not X, not Y, but Z." Also "Z. Not Y." inversions.
- Emphasis-via-fragment after a positive setup ("Different problem." "Worth knowing.").
- Rhetorical triples ("real numbers, real learners, real enrolments").
- Copywriter hook tics: "Here's the thing:", "What surprised me most was:", "Let me explain.".
- Filler openers: "Great question", "Certainly", "Of course", "Absolutely".
- AI-flavoured words: "dive into", "unleash", "elevate", "game-changer", "seamless", "robust", "leverage", "delve", "at the end of the day", "in today's world", "it's worth noting".
- Corporate waffle: "solutions", "synergy", "ecosystem", "streamline" (unless genuinely accurate).
- Exclamation marks unless the context genuinely calls for one (rare).

Charlotte's voice signature moves:
- Soft asks: "No problem if not, but..." removes pressure without sounding uncertain.
- Parenthetical reasoning: drop a short insight in brackets to justify a choice ("(it helps people self-screen before they apply)"). Same shape as "Clearer intent, better conversion."
- Closing pattern for instructional posts: "If you want to [do specific thing], that's the door." or similar low-pressure CTA.
- Trust signals go inline and factually, never promotionally.

# Blog content standards

Posts are educational, plain-spoken UK guides. The goal is to rank on Google for "how to change career UK", "free funded training UK", and similar long-tail queries — and to convert those readers into Switchable course-finder leads.

Structure for a typical post:
- Title 40-60 chars, action-shaped, names the outcome.
- Dek (sub-headline) one sentence positioning the post under the title.
- H2 sections (3-7) with H3 sub-sections only when genuinely needed.
- Body ≥ 600 words for ranking; 1000+ for pillar pieces.
- At least 2 internal links to other Switchable pages (course finder, related posts, /find-funded-courses/).
- Closing section drops the reader into a soft CTA.

SEO field standards:
- Meta title: ≤ 60 chars (Google cut).
- Meta description: 140-160 chars (Google snippet sweet spot).
- Excerpt: 140-200 chars for clean listings; doubles as meta description fallback.

# How to respond

Match each suggestion to the brand voice and audience above. Don't explain what you're producing or apologise for length — just produce the suggestion in the exact format the user requests. If asked for JSON, return parseable JSON only, no prose around it.

Examples of Charlotte's voice in published blog drafts:

Title: "How to change career in the UK without quitting first"
Dek: "You don't need a six-month savings buffer or a leap of faith. You need a plan and a few facts most people don't know."

Title: "Pensions, savings, and the real cost of a UK career change"
Dek: "Career change advice rarely covers the money side. The real cost is not the tuition. It is the lost-earnings month and the pension you forgot to consolidate. Here's how the maths actually breaks down."

Title: "Starting a business in your 40s in the UK"
Dek: "The data nobody mentions: 40-49 is the highest-success-rate age band for new UK businesses. Here's what actually changes when you start late, and what to plan for."

Title: "What funded training actually means"
Dek: "Every UK adult has heard of 'funded courses' but nobody explains what funded actually means. Here's the honest version — who pays, what gets covered, and the catch behind 'free'."

Notice the patterns: opener subverts a common assumption with a fact, dek delivers the angle in one or two sentences, no clickbait, no exclamation marks, no em dashes.

Closing patterns for educational posts:
- "If you want to stop reading career-change articles and look at three real options, that's the door."
- "Run the maths once at month six. If the new role is paying what you expected and the lost-earnings gap was inside the budget, the plan worked."
- "The maths usually works. It tends to look worse on paper than it does in practice."

Subject-line examples that fit the voice:
- "What X actually unlocks for the business"
- "Three doubts every business owner has"
- "Still in for [date]?"

If the user gives you a current draft value and asks for an improvement, anchor your improvement to what they've written — don't ignore their input. If you're producing from scratch, anchor to the title, dek, and body provided.

You will produce ONLY what the user asks for in the exact requested format. No preamble, no meta-commentary, no "here's what I came up with". Just the suggestion.`;

interface SurfaceConfig {
  // user-turn prompt builder
  buildUser: (req: AssistRequest) => string;
  // structured-output schema for JSON surfaces; undefined for plain-text surfaces
  schema?: Record<string, unknown>;
  // how to extract the final string/array from Claude's response
  extract: (responseText: string) => unknown;
}

const SURFACES: Record<Kind, SurfaceConfig> = {
  outline: {
    buildUser: (r) => {
      const p = r.post;
      return [
        "Suggest a H2 outline for this blog post.",
        "",
        `Title: ${p.title ?? "(no title yet)"}`,
        p.dek ? `Dek: ${p.dek}` : "",
        p.target_keywords && p.target_keywords.length > 0
          ? `Target keywords: ${p.target_keywords.join(", ")}`
          : "",
        p.current_value
          ? `Existing outline (improve this):\n${p.current_value}`
          : "",
        "",
        "Return 5-7 H2 headings as a markdown list (one ## heading per line, no body content under them). Each heading should be 4-9 words, action-shaped where possible, plain UK English. Cover the topic logically from setup → meat → close.",
      ].filter(Boolean).join("\n");
    },
    extract: (text) => text.trim(),
  },

  headlines: {
    buildUser: (r) => {
      const p = r.post;
      const anchors = extractAnchorSubjects(p.title ?? "");
      const anchorBlock = anchors.length > 0
        ? `ANCHOR SUBJECTS (these define what makes this post different from a generic career-change article). At least 4 of your 5 titles MUST contain at least one of these subjects (or an obvious singular/plural variant). A title that could apply to any career-change post in general is wrong:\n${anchors.map((a) => `- ${a}`).join("\n")}`
        : "";
      return [
        "Suggest 5 title variants for THIS specific post. Read the body excerpt below before writing anything. Every variant must genuinely fit what the post actually covers. Do not widen the topic to generic career-change content; do not drop the specific subjects the title and body anchor to.",
        "",
        p.title ? `Current draft title: ${p.title}` : "",
        p.dek ? `Dek: ${p.dek}` : "",
        p.target_keywords && p.target_keywords.length > 0
          ? `Target keywords: ${p.target_keywords.join(", ")}`
          : "",
        anchorBlock,
        p.body
          ? `Body excerpt (start + end so you see the actual angle, not just the intro):\n${sample(p.body, 1500)}`
          : "",
        "",
        "RULES:",
        "- 40-60 characters each.",
        "- Plain UK English. No clickbait. No exclamation marks. No em dashes.",
        "- Mix angles across the 5: 1 plain-literal, 1 question-shaped, 1 contrarian-but-honest, 1 outcome-focused, 1 with a real number/year/cohort where it fits naturally. BUT all 5 must still anchor to the post's actual subjects per the list above.",
        "",
        "BANNED PATTERNS (titles using these will be rejected and you will be asked to retry):",
        "- 'X is not Y' / 'X isn't Y. It's Z.' setup-and-reveal pairs.",
        "- Clipped emphasis fragments after a positive setup ('Worth knowing.', 'Different problem.', 'Three reasons.').",
        "- Rhetorical triples ('real numbers, real learners, real results').",
        "- 'Here's the thing' / 'What surprised me most was' tics.",
      ].filter(Boolean).join("\n");
    },
    // NB: Anthropic's json_schema validator only supports minItems values
    // of 0 or 1 (anything else returns invalid_request_error). The exact
    // count is enforced in the user prompt instead ("Each title 40-60
    // characters... Mix angles: 1 plain literal, 1 question-shaped...").
    // extract() trims to 5 in JS as a safety net if the model returns more.
    schema: {
      type: "object",
      properties: {
        titles: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
      },
      required: ["titles"],
      additionalProperties: false,
    },
    extract: (text) => {
      const parsed = JSON.parse(text) as { titles: string[] };
      return parsed.titles.slice(0, 5);
    },
  },

  meta_description: {
    buildUser: (r) => {
      const p = r.post;
      return [
        "Write a Google meta description for this blog post.",
        "",
        `Title: ${p.title ?? "(no title)"}`,
        p.dek ? `Dek: ${p.dek}` : "",
        p.target_keywords && p.target_keywords.length > 0
          ? `Target keywords: ${p.target_keywords.join(", ")}`
          : "",
        p.body
          ? `Body excerpt (start + end so meta-description anchors to the whole post, not just the lead):\n${sample(p.body, 600)}`
          : "",
        p.current_value
          ? `Existing meta description (improve this):\n${p.current_value}`
          : "",
        "",
        "140-160 characters. Sells the click without over-promising. Includes the primary keyword naturally. Ends mid-thought when the value's clear (Google often cuts there anyway). Plain UK English. No exclamation marks, no em dashes.",
        "",
        "Return only the meta description text, no quotes, no preamble.",
      ].filter(Boolean).join("\n");
    },
    extract: (text) => text.trim().replace(/^["']|["']$/g, ""),
  },

  excerpt: {
    buildUser: (r) => {
      const p = r.post;
      return [
        "Write an excerpt for this blog post, used in /blog/ listings and as a meta description fallback.",
        "",
        `Title: ${p.title ?? "(no title)"}`,
        p.dek ? `Dek: ${p.dek}` : "",
        p.body
          ? `Body excerpt (start + end so the model sees both intro and conclusion):\n${sample(p.body, 800)}`
          : "",
        p.current_value
          ? `Existing excerpt (improve this):\n${p.current_value}`
          : "",
        "",
        "2-3 sentences, 140-200 characters. Names the post's angle in plain UK English. Pulls the reader in without giving away the answer. No exclamation marks, no em dashes.",
        "",
        "Return only the excerpt text, no quotes, no preamble.",
      ].filter(Boolean).join("\n");
    },
    extract: (text) => text.trim().replace(/^["']|["']$/g, ""),
  },

  tags: {
    buildUser: (r) => {
      const p = r.post;
      const known = (r.known_tags ?? []).map((t) => `${t.slug} (${t.name})`).join(", ");
      return [
        "Suggest 3-6 tags for this blog post from the registry below.",
        "",
        `Title: ${p.title ?? "(no title)"}`,
        p.dek ? `Dek: ${p.dek}` : "",
        p.target_keywords && p.target_keywords.length > 0
          ? `Target keywords: ${p.target_keywords.join(", ")}`
          : "",
        p.body
          ? `Body excerpt (start + end so the model sees both intro and conclusion):\n${sample(p.body, 800)}`
          : "",
        "",
        `Available tags (slug, name): ${known || "(no tags in registry)"}`,
        "",
        "Pick 3-6 slugs from this registry that genuinely apply. Do NOT invent new slugs — only return slugs from the list above. Order by relevance (most relevant first).",
      ].filter(Boolean).join("\n");
    },
    // maxItems also drops here — Anthropic's validator pairs minItems/
    // maxItems; safer to enforce in JS. User prompt says "3-6 tags".
    schema: {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
      },
      required: ["tags"],
      additionalProperties: false,
    },
    extract: (text) => {
      const parsed = JSON.parse(text) as { tags: string[] };
      return parsed.tags.slice(0, 8);
    },
  },
};

const KIND_LIST: Kind[] = ["outline", "headlines", "meta_description", "excerpt", "tags"];

// sample(body, total) — pull head + tail of a long body so the model sees
// both the intro and the conclusion. Short bodies just return the whole
// thing. Used to give meta-description and excerpt surfaces the full
// thematic shape instead of just the lead paragraph.
function sample(body: string, total: number): string {
  if (body.length <= total) return body;
  const half = Math.floor(total / 2);
  const head = body.slice(0, half).trim();
  const tail = body.slice(-half).trim();
  return `${head}\n\n[...]\n\n${tail}`;
}

// extractAnchorSubjects(title) — pull the distinctive nouns out of a
// title so the headlines prompt can demand the model keep them. Stopword
// list trims connective tissue ("the", "and", "real cost of a", ...) so
// what's left is the differentiating content. Returns up to 4 anchors.
const TITLE_STOPWORDS = new Set([
  "the","a","an","of","and","or","but","to","for","in","on","at","by","with","from",
  "is","are","was","were","be","been","being","do","does","did",
  "uk","england","british","that","this","these","those","your","you","i","we",
  "how","why","what","when","where","who","which",
  "into","out","up","down","over","under","than","then","also",
  "no","not","yes","real","new","old","first","next","last",
  "post","article","guide","story",
  // generic blog-topic words that aren't subject-anchors
  "cost","costs","change","changing","money","career","careers","work","working",
  "without","with",
]);

function extractAnchorSubjects(title: string): string[] {
  if (!title) return [];
  // Split on punctuation + spaces, lowercase, dedupe.
  const tokens = title
    .toLowerCase()
    .split(/[\s,;:\-/()'"!?.]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !TITLE_STOPWORDS.has(t));
  // De-dupe preserving order; cap at 4 strongest signals.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
      if (out.length >= 4) break;
    }
  }
  return out;
}

// titleHitsAnyAnchor(title, anchors) — case-insensitive substring check.
// Singulars match plurals (anchors are usually already plural; we also
// trim trailing 's' from each title token before checking).
function titleHitsAnyAnchor(title: string, anchors: string[]): boolean {
  if (anchors.length === 0) return true;
  const lower = title.toLowerCase();
  for (const a of anchors) {
    if (lower.includes(a)) return true;
    // singular/plural fallback
    if (a.endsWith("s") && lower.includes(a.slice(0, -1))) return true;
    if (!a.endsWith("s") && lower.includes(a + "s")) return true;
  }
  return false;
}

// describeError(err) — always returns a non-empty human-readable string.
// Falls back through several shapes the Anthropic SDK + Deno runtime can
// throw (typed SDK errors with `.status`/`.error.type`, plain Errors with
// `.message`, raw objects). Critical: never returns "" — the admin UI
// rendered an empty red box when the previous version did.
function describeError(err: unknown): string {
  if (err === null || err === undefined) return "unknown error (null thrown)";
  const e = err as { status?: number; name?: string; message?: string; error?: { type?: string; message?: string } };
  const parts: string[] = [];
  if (e.status) parts.push(`HTTP ${e.status}`);
  if (e.name && e.name !== "Error") parts.push(e.name);
  if (e.error?.type) parts.push(e.error.type);
  if (e.error?.message) parts.push(e.error.message);
  else if (e.message) parts.push(e.message);
  if (parts.length > 0) return parts.join(" | ");
  // Last-resort fallback. JSON.stringify can throw on circular refs or
  // serialise to "{}" for plain Error objects, so catch + try toString +
  // try Object.getOwnPropertyNames before giving up.
  try {
    const json = JSON.stringify(err, Object.getOwnPropertyNames(err as object));
    if (json && json !== "{}" && json !== "null") return json;
  } catch { /* fall through */ }
  const str = String(err);
  return str && str !== "[object Object]" ? str : `unknown error (typeof ${typeof err})`;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }

  // Auth — same x-audit-key pattern as admin-brevo-resync / port-blog-yaml.
  // Source the expected secret from the DB vault (single source of truth)
  // rather than Deno.env so we don't have to keep two copies in sync —
  // the admin Server Action also reads from the vault, so they match
  // automatically.
  const auditKey = req.headers.get("x-audit-key");
  let expected: string | null = null;
  try {
    const rows = await sql<Array<{ secret: string }>>`
      SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
    `;
    expected = rows[0]?.secret ?? null;
  } catch (err) {
    console.error("blog-ai-assist: vault secret fetch failed:", String(err));
    return json({ ok: false, error: "AUDIT_SHARED_SECRET not retrievable from vault" }, 500);
  }
  if (!expected) {
    return json({ ok: false, error: "AUDIT_SHARED_SECRET not in vault" }, 500);
  }
  if (!auditKey || auditKey !== expected) {
    return json({ ok: false, error: "unauthorised (x-audit-key mismatch)" }, 401);
  }

  let body: AssistRequest;
  try {
    body = await req.json() as AssistRequest;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  if (!body || !KIND_LIST.includes(body.kind)) {
    return json({ ok: false, error: `kind must be one of ${KIND_LIST.join(" / ")}` }, 400);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json({ ok: false, error: "ANTHROPIC_API_KEY not set in Edge Function env" }, 500);
  }

  // Rate limit: per-API-key budget against editorial.ai_assist_log so a
  // runaway client can't drain Charlotte's Anthropic spend. Hard caps:
  // 30 calls/minute, 200/day. Cheap query: indexed scan on created_at.
  try {
    const limits = await sql`
      SELECT
        count(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 minute') AS per_min,
        count(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')    AS per_day
      FROM editorial.ai_assist_log
    `;
    const perMin = Number(limits[0]?.per_min ?? 0);
    const perDay = Number(limits[0]?.per_day ?? 0);
    if (perMin >= 30) {
      return json({ ok: false, error: "Rate limit: 30 calls per minute reached. Wait a minute and retry." }, 429);
    }
    if (perDay >= 200) {
      return json({ ok: false, error: "Rate limit: 200 calls per day reached. Resets at midnight UTC." }, 429);
    }
  } catch (rlErr) {
    // Rate-limit check should fail-open (don't block real work on a log
    // table read failure). Continue but log.
    console.warn("rate-limit check failed (fail-open):", rlErr);
  }

  const surface = SURFACES[body.kind];
  const client = new Anthropic({ apiKey });
  const startedAt = Date.now();

  let suggestion: unknown = null;
  let usage = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  let ok = false;
  let errorMessage: string | null = null;

  // Single-call helper so we can retry once if a quality check fails
  // (headlines anchor coverage, currently). Accumulates token usage
  // across calls so the cost log reflects every API hit.
  async function callOnce(userPrompt: string): Promise<unknown> {
    const params: Record<string, unknown> = {
      model: MODEL,
      max_tokens: 1024,
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    };
    if (surface.schema) {
      (params.output_config as Record<string, unknown>).format = {
        type: "json_schema",
        schema: surface.schema,
      };
    }
    const response = await client.messages.create(params as never);
    usage.input          += response.usage.input_tokens ?? 0;
    usage.output         += response.usage.output_tokens ?? 0;
    usage.cache_read     += response.usage.cache_read_input_tokens ?? 0;
    usage.cache_creation += response.usage.cache_creation_input_tokens ?? 0;
    let responseText = "";
    let structured: unknown = null;
    for (const block of response.content as Array<Record<string, unknown>>) {
      const t = block.type as string;
      if (t === "text" && typeof block.text === "string") {
        responseText += block.text;
      } else if (t === "json" || t === "structured_output") {
        structured = (block.json ?? block.input ?? block.output) as unknown;
      } else if (t === "tool_use" && block.input) {
        structured = block.input as unknown;
      }
    }
    if (surface.schema && structured !== null) return structured;
    if (!responseText.trim()) {
      throw new Error(surface.schema
        ? "Empty response from model (expected JSON for structured surface)"
        : "Empty response from model");
    }
    return surface.extract(responseText);
  }

  try {
    suggestion = await callOnce(surface.buildUser(body));

    // Headlines anchor-coverage check. The prompt asks for at least 4 of 5
    // titles to mention an anchor subject from the post's current title;
    // models still sometimes generalise away from the subject. If coverage
    // is weak (and we have anchors at all), one retry with the failed batch
    // shown back to the model usually fixes it.
    if (body.kind === "headlines" && Array.isArray(suggestion)) {
      const anchors = extractAnchorSubjects(body.post?.title ?? "");
      const titles = suggestion as string[];
      const hits = titles.filter((t) => titleHitsAnyAnchor(t, anchors)).length;
      const REQUIRED_HITS = 4;
      if (anchors.length > 0 && hits < REQUIRED_HITS) {
        console.warn(`headlines: only ${hits}/${titles.length} hit anchors ${JSON.stringify(anchors)} — retrying once.`);
        const retryPrompt = [
          surface.buildUser(body),
          "",
          "RETRY. Your previous attempt produced these 5 titles:",
          ...titles.map((t, i) => `${i + 1}. ${t}`),
          "",
          `Only ${hits} of them contained one of the anchor subjects (${anchors.join(", ")}). This is a hard fail. Try again — ALL 5 titles must contain at least one anchor subject (or its singular/plural form). A title that could apply to a generic UK career-change post is wrong and must be discarded.`,
        ].join("\n");
        const retryResult = await callOnce(retryPrompt);
        if (Array.isArray(retryResult)) {
          const retryTitles = retryResult as string[];
          const retryHits = retryTitles.filter((t) => titleHitsAnyAnchor(t, anchors)).length;
          // Only adopt the retry if it actually did better.
          if (retryHits > hits) {
            suggestion = retryResult;
          }
        }
      }
    }

    ok = true;
  } catch (err) {
    errorMessage = describeError(err);
    console.error(`blog-ai-assist [${body.kind}] failed:`, errorMessage);
    console.error(`blog-ai-assist [${body.kind}] raw err:`, err);
    try {
      console.error(`blog-ai-assist [${body.kind}] json:`, JSON.stringify(err, Object.getOwnPropertyNames(err as object)));
    } catch { /* JSON.stringify can throw on circular */ }
  }

  const costUsd =
    (usage.input          * PRICE_INPUT_PER_M          / 1_000_000) +
    (usage.output         * PRICE_OUTPUT_PER_M         / 1_000_000) +
    (usage.cache_creation * PRICE_CACHE_CREATION_PER_M / 1_000_000) +
    (usage.cache_read     * PRICE_CACHE_READ_PER_M     / 1_000_000);

  // Log every call (success + failure). Errors during logging must not block
  // the response — Charlotte gets the suggestion (or error) regardless.
  try {
    await sql`
      INSERT INTO editorial.ai_assist_log
        (kind, post_id, post_slug, model,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         cost_usd, latency_ms, ok, error_message)
      VALUES
        (${body.kind}, ${body.post_id ?? null}, ${body.post_slug ?? null}, ${MODEL},
         ${usage.input}, ${usage.output}, ${usage.cache_read}, ${usage.cache_creation},
         ${costUsd}, ${Date.now() - startedAt}, ${ok}, ${errorMessage})
    `;
  } catch (logErr) {
    console.error("blog-ai-assist: cost log insert failed (non-blocking):", logErr);
  }

  if (!ok) {
    // `|| ` not `?? ` — empty string is technically not nullish so we'd
    // pass it through and the admin UI would render an empty error box.
    return json({ ok: false, error: errorMessage || "unknown error (empty message)" }, 502);
  }

  return json({
    ok: true,
    suggestion,
    usage: {
      ...usage,
      cost_usd: Number(costUsd.toFixed(6)),
      latency_ms: Date.now() - startedAt,
      model: MODEL,
    },
  }, 200);
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
