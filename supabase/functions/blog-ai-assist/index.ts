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
import Anthropic from "npm:@anthropic-ai/sdk";

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
      return [
        "Suggest 5 title variants for this blog post.",
        "",
        p.title ? `Current draft title: ${p.title}` : "",
        p.dek ? `Dek: ${p.dek}` : "",
        p.target_keywords && p.target_keywords.length > 0
          ? `Target keywords: ${p.target_keywords.join(", ")}`
          : "",
        p.body
          ? `First paragraph of body:\n${p.body.split("\n\n").slice(0, 1).join("\n\n").slice(0, 400)}`
          : "",
        "",
        "Each title 40-60 characters. Action-shaped. Names the outcome. Plain UK English. No clickbait, no exclamation marks. Mix angles: 1 plain literal, 1 question-shaped, 1 contrarian, 1 outcome-focused, 1 with a number where it fits naturally.",
      ].filter(Boolean).join("\n");
    },
    schema: {
      type: "object",
      properties: {
        titles: {
          type: "array",
          items: { type: "string" },
          minItems: 5,
          maxItems: 5,
        },
      },
      required: ["titles"],
      additionalProperties: false,
    },
    extract: (text) => {
      const parsed = JSON.parse(text) as { titles: string[] };
      return parsed.titles;
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
          ? `First 600 chars of body:\n${p.body.slice(0, 600)}`
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
          ? `First 800 chars of body:\n${p.body.slice(0, 800)}`
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
          ? `First 800 chars of body:\n${p.body.slice(0, 800)}`
          : "",
        "",
        `Available tags (slug, name): ${known || "(no tags in registry)"}`,
        "",
        "Pick 3-6 slugs from this registry that genuinely apply. Do NOT invent new slugs — only return slugs from the list above. Order by relevance (most relevant first).",
      ].filter(Boolean).join("\n");
    },
    schema: {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 8,
        },
      },
      required: ["tags"],
      additionalProperties: false,
    },
    extract: (text) => {
      const parsed = JSON.parse(text) as { tags: string[] };
      return parsed.tags;
    },
  },
};

const KIND_LIST: Kind[] = ["outline", "headlines", "meta_description", "excerpt", "tags"];

serve(async (req) => {
  if (req.method !== "POST") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }

  // Auth — same x-audit-key pattern as admin-brevo-resync / port-blog-yaml.
  const auditKey = req.headers.get("x-audit-key");
  const expected = Deno.env.get("AUDIT_SHARED_SECRET");
  if (!auditKey || auditKey !== expected) {
    return json({ ok: false, error: "unauthorised" }, 401);
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

  const surface = SURFACES[body.kind];
  const client = new Anthropic({ apiKey });
  const startedAt = Date.now();

  let suggestion: unknown = null;
  let usage = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  let ok = false;
  let errorMessage: string | null = null;

  try {
    // Top-level cache_control auto-places on the last cacheable block (in
    // this case, the system prompt). System renders before messages, so the
    // marker caches the entire system prompt across calls.
    const params: Record<string, unknown> = {
      model: MODEL,
      max_tokens: 1024,
      // Opus 4.7 needs effort explicitly. medium = good cost/quality for
      // short generation; high would over-spend tokens on a tagline.
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: surface.buildUser(body) }],
    };

    if (surface.schema) {
      // Structured outputs for headlines + tags via output_config.format.
      // The model returns a JSON string that matches the schema; surface.extract
      // parses + unwraps it.
      (params.output_config as Record<string, unknown>).format = {
        type: "json_schema",
        schema: surface.schema,
      };
    }

    const response = await client.messages.create(params as never);

    // Pull out the first text block. Structured + plain both surface as text.
    let responseText = "";
    for (const block of response.content) {
      if (block.type === "text") responseText += block.text;
    }

    suggestion = surface.extract(responseText);
    usage = {
      input: response.usage.input_tokens ?? 0,
      output: response.usage.output_tokens ?? 0,
      cache_read: response.usage.cache_read_input_tokens ?? 0,
      cache_creation: response.usage.cache_creation_input_tokens ?? 0,
    };
    ok = true;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`blog-ai-assist [${body.kind}] failed:`, errorMessage);
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
    return json({ ok: false, error: errorMessage ?? "unknown error" }, 502);
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
