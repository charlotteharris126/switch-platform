// SEO + social best-practice rules for the blog CMS editor.
//
// Designed to grade a post against a real SEO framework, not a placeholder
// checklist. Each rule maps to a current (2024-2026) ranking signal:
//
//   - "Required"     — won't ship safely without these (slug, title, body)
//   - "Keyword"      — what Google's NLP looks for (slug match, in-title,
//                      meta, headings, opening, density, semantic variants)
//   - "On-page"      — content depth, link signals (internal + outbound
//                      authority), taxonomy
//   - "Readability"  — sentence length, paragraph length, heading
//                      hierarchy — Google reads these via NLP + UX signals
//                      (dwell time, scroll), and AI Overviews skim short
//                      well-structured passages
//   - "Social"       — OG / Twitter card readiness for share previews
//   - "Defaults"     — info-only: what will actually render once fallbacks
//                      apply (meta title → title, og image → cover, etc.)
//
// What this still DOESN'T cover (handled by the build script):
//   - Emitting <meta>, OG, Twitter card tags in the rendered HTML
//   - JSON-LD Article + BlogPosting schema
//   - Sitemap inclusion (already handled by scripts/build-sitemap.js)
//   - LCP / page-speed / Core Web Vitals (different layer)
//   - Image dimensions (1200×630 OG check — handled by media upload UI)

import type { PostFormInput } from "./actions";

export type CheckStatus = "pass" | "warn" | "fail" | "info";
export type CheckGroup = "required" | "keyword_usage" | "on_page" | "readability" | "aeo" | "social" | "defaults";

// Authoritative outbound domains. A post citing one of these signals
// "this content is connected to authoritative sources" — Google likes
// outbound links to good sources, contrary to old myths about leaking
// link juice. Keep the list aligned with the drafter EF's SAFE_LINK_DOMAINS.
const AUTHORITATIVE_DOMAINS = [
  "gov.uk", "ons.gov.uk", "skillsengland.education.gov.uk",
  "officeforstudents.org.uk", "explore-education-statistics.service.gov.uk",
  "nationalcareers.service.gov.uk", "ifate.education.gov.uk",
  "instituteforapprenticeships.org", "gov.scot", "gov.wales", "nidirect.gov.uk",
  "europa.eu", "oecd.org", "worldbank.org", "ilo.org",
];

export type SeoCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  message: string;
  group: CheckGroup;
};

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function countMarkdownLinks(body: string): { internal: number; external: number; authoritative: number; externalUrls: string[] } {
  // Markdown links: [text](url). Doesn't catch reference-style links — those
  // are rare in our content; can be added later if needed.
  const matches = body.match(/\]\(([^)]+)\)/g) ?? [];
  let internal = 0;
  let external = 0;
  let authoritative = 0;
  const externalUrls: string[] = [];
  for (const m of matches) {
    const url = m.slice(2, -1).trim();
    if (!url || url.startsWith("#") || url.startsWith("mailto:")) continue;
    if (url.startsWith("/") || url.includes("switchable.org.uk")) {
      internal++;
    } else {
      external++;
      externalUrls.push(url);
      if (AUTHORITATIVE_DOMAINS.some((d) => url.includes(d))) authoritative++;
    }
  }
  return { internal, external, authoritative, externalUrls };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const re = new RegExp(escapeRegex(needle), "g");
  return (haystack.match(re) ?? []).length;
}

function stripMarkdown(body: string): string {
  // Crude but adequate: strip links to their anchor text, headings markers,
  // bullets, and code fences. Used for readability metrics where we want the
  // prose, not the markup.
  return body
    .replace(/```[\s\S]*?```/g, "")          // fenced code
    .replace(/`[^`]+`/g, "")                  // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")     // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")  // links → anchor text
    .replace(/^#{1,6}\s+/gm, "")              // heading markers
    .replace(/^[-*+]\s+/gm, "")               // bullets
    .replace(/^\d+\.\s+/gm, "")               // numbered lists
    .replace(/[*_~]/g, "")                    // bold/italic markers
    .trim();
}

function sentencesOf(prose: string): string[] {
  // Naïve sentence split — good enough for editorial prose. Splits on
  // .!? followed by whitespace + capital letter. Filters out fragments.
  const raw = prose
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z])/);
  return raw.map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 3);
}

function paragraphsOf(body: string): string[] {
  return body.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0 && !p.startsWith("#"));
}

function h2Count(body: string): number {
  return body.split("\n").filter((l) => /^##\s/.test(l)).length;
}

function headingHierarchy(body: string): { ok: boolean; jumps: string[] } {
  // Validate Markdown headings follow H2 → H3 → H4 nesting. The post H1 is
  // the title (rendered separately), so the body should start at H2 and
  // never skip a level (no H2 → H4).
  const lines = body.split("\n");
  const levels: number[] = [];
  for (const line of lines) {
    const m = line.match(/^(#{2,6})\s/);
    if (m) levels.push(m[1].length);
  }
  const jumps: string[] = [];
  for (let i = 0; i < levels.length; i++) {
    const lvl = levels[i];
    const prev = i === 0 ? 2 : levels[i - 1];
    if (lvl > prev + 1) {
      jumps.push(`${"#".repeat(prev)} → ${"#".repeat(lvl)}`);
    }
  }
  return { ok: jumps.length === 0, jumps };
}

export function effectiveMetaTitle(input: PostFormInput): string {
  return input.meta_title.trim() || input.title.trim();
}

export function effectiveMetaDescription(input: PostFormInput): string {
  return input.meta_description.trim() || input.excerpt.trim();
}

export function effectiveOgTitle(input: PostFormInput): string {
  return input.og_title.trim() || effectiveMetaTitle(input);
}

export function effectiveOgDescription(input: PostFormInput): string {
  return input.og_description.trim() || effectiveMetaDescription(input);
}

export function effectiveOgImage(input: PostFormInput): string {
  return input.og_image_url.trim() || input.cover_image_url.trim();
}

export function effectiveCanonical(input: PostFormInput): string {
  return input.canonical_url.trim() || (input.slug.trim() ? `/blog/${input.slug.trim()}/` : "");
}

export function checkSeo(input: PostFormInput, knownTagSlugs: Set<string>): SeoCheck[] {
  const checks: SeoCheck[] = [];

  // ---- Required (block publish if missing) ----------------------------------

  const slug = input.slug.trim();
  if (!slug) {
    checks.push({ id: "slug_present", label: "URL slug", status: "fail", message: "Required.", group: "required" });
  } else if (!SLUG_RE.test(slug)) {
    checks.push({ id: "slug_format", label: "URL slug format", status: "fail", message: "Lowercase letters, numbers, hyphens only.", group: "required" });
  } else if (slug.length > 75) {
    checks.push({ id: "slug_length", label: "URL slug length", status: "warn", message: `${slug.length} chars — keep under 75 for shareable URLs.`, group: "required" });
  } else {
    checks.push({ id: "slug_ok", label: "URL slug", status: "pass", message: `/blog/${slug}/`, group: "required" });
  }

  const title = input.title.trim();
  if (!title) {
    checks.push({ id: "title_present", label: "Title", status: "fail", message: "Required.", group: "required" });
  } else if (title.length > 60) {
    checks.push({ id: "title_too_long", label: "Title length", status: "warn", message: `${title.length} chars — Google truncates past ~60 chars in SERP. Tighten to 50-60.`, group: "required" });
  } else if (title.length < 40) {
    checks.push({ id: "title_short", label: "Title length", status: "warn", message: `${title.length} chars — short titles often miss CTR potential. 50-60 is the sweet spot.`, group: "required" });
  } else {
    checks.push({ id: "title_ok", label: "Title length", status: "pass", message: `${title.length} chars`, group: "required" });
  }

  if (!input.body.trim()) {
    checks.push({ id: "body_present", label: "Body", status: "fail", message: "Required.", group: "required" });
  }

  if ((input.status === "scheduled" || input.status === "published") && !input.publish_date) {
    checks.push({ id: "publish_date_required", label: "Publish date", status: "fail", message: "Required when status is scheduled or published.", group: "required" });
  }

  // ---- On-page SEO ---------------------------------------------------------

  const words = wordCount(input.body);
  if (words === 0) {
    /* already flagged above */
  } else if (words < 600) {
    checks.push({ id: "body_length", label: "Body length", status: "warn", message: `${words} words — under 600 rarely ranks for competitive terms.`, group: "on_page" });
  } else if (words < 1000) {
    checks.push({ id: "body_length", label: "Body length", status: "pass", message: `${words} words — good for most topics.`, group: "on_page" });
  } else {
    checks.push({ id: "body_length", label: "Body length", status: "pass", message: `${words} words — long-form, strong signal for depth topics.`, group: "on_page" });
  }

  // H1 should not be in the body — the build wraps the post title as the H1.
  if (input.body.match(/^#\s/m)) {
    checks.push({ id: "body_h1", label: "H1 in body", status: "warn", message: "Body uses `# ` headings. Drop one level — the title is already the page H1. Use `## ` for top-level sections.", group: "on_page" });
  } else {
    checks.push({ id: "body_h1", label: "H1 in body", status: "pass", message: "Title is the only H1 (correct).", group: "on_page" });
  }

  const links = countMarkdownLinks(input.body);
  if (links.internal === 0) {
    checks.push({ id: "internal_links", label: "Internal links", status: "warn", message: "No internal links in the body. Aim for 2-3 to other Switchable pages (course finder, related posts, /find-funded-courses/) — helps both SEO and reader flow.", group: "on_page" });
  } else if (links.internal === 1) {
    checks.push({ id: "internal_links", label: "Internal links", status: "warn", message: `${links.internal} internal link — add 1-2 more once there are more posts/courses to link to. (If the site has few published posts, this resolves naturally as you publish.)`, group: "on_page" });
  } else {
    checks.push({ id: "internal_links", label: "Internal links", status: "pass", message: `${links.internal} internal · ${links.external} external`, group: "on_page" });
  }

  // Outbound authoritative links — Google rewards posts that cite quality
  // sources. The old myth "outbound links leak link juice" has been retired
  // since 2015 — outbound authority IS an E-E-A-T signal now.
  if (links.authoritative === 0) {
    checks.push({
      id: "outbound_authority",
      label: "Authoritative outbound links",
      status: "warn",
      message: `No outbound links to authoritative sources (gov.uk, ONS, official bodies). Add 1-2 to back numeric claims — E-E-A-T signal.`,
      group: "on_page",
    });
  } else {
    checks.push({
      id: "outbound_authority",
      label: "Authoritative outbound links",
      status: "pass",
      message: `${links.authoritative} authoritative outbound link${links.authoritative === 1 ? "" : "s"} (${links.external} external total).`,
      group: "on_page",
    });
  }

  if (!input.excerpt.trim()) {
    checks.push({ id: "excerpt", label: "Excerpt", status: "warn", message: "Missing. Used in /blog/ listings and as meta-description fallback. Write 2-3 sentences.", group: "on_page" });
  } else if (input.excerpt.length > 200) {
    checks.push({ id: "excerpt_length", label: "Excerpt length", status: "warn", message: `${input.excerpt.length} chars — keep under ~200 for clean listings.`, group: "on_page" });
  } else {
    checks.push({ id: "excerpt", label: "Excerpt", status: "pass", message: `${input.excerpt.length} chars`, group: "on_page" });
  }

  const kw = input.target_keywords.split(",").map((s) => s.trim()).filter(Boolean);
  if (kw.length === 0) {
    checks.push({ id: "target_keywords", label: "Target keywords", status: "warn", message: "None set. Add 1-3 primary keywords so you can audit ranking later.", group: "on_page" });
  } else if (kw.length > 5) {
    checks.push({ id: "target_keywords_many", label: "Target keywords", status: "warn", message: `${kw.length} keywords — pick the 3 strongest. More than 5 dilutes intent.`, group: "on_page" });
  } else {
    checks.push({ id: "target_keywords", label: "Target keywords", status: "pass", message: `${kw.length} (${kw.join(", ")})`, group: "on_page" });
  }

  if (!input.category_id) {
    checks.push({ id: "category", label: "Category", status: "warn", message: "Uncategorised. Category drives /blog/ section listings and breadcrumb.", group: "on_page" });
  } else {
    checks.push({ id: "category", label: "Category", status: "pass", message: input.category_id, group: "on_page" });
  }

  const tagSlugs = input.tags.split(",").map((s) => s.trim()).filter(Boolean);
  if (tagSlugs.length === 0) {
    checks.push({ id: "tags", label: "Tags", status: "warn", message: "No tags. Each tag generates a hub page; tagging adds crawl paths to this post.", group: "on_page" });
  } else {
    const unknown = tagSlugs.filter((s) => !knownTagSlugs.has(s));
    if (unknown.length > 0) {
      checks.push({ id: "tags_unknown", label: "Tags", status: "warn", message: `Unknown slugs (will be ignored): ${unknown.join(", ")}. Create them in /admin/blog/tags first.`, group: "on_page" });
    } else {
      checks.push({ id: "tags", label: "Tags", status: "pass", message: `${tagSlugs.length} (${tagSlugs.join(", ")})`, group: "on_page" });
    }
  }

  // ---- Keyword usage --------------------------------------------------------
  // Google's NLP doesn't reward exact-match stuffing any more, but PRESENCE
  // of the primary keyword in the high-signal locations (title, URL, meta,
  // headings, opening) still strongly correlates with ranking. We check
  // primary verbatim where it matters; for headings + body density we also
  // accept target_keyword variants (Google's BERT understands the variants
  // are the same intent).

  const primaryKw = (kw[0] ?? "").trim().toLowerCase();
  const allKws = kw.map((k) => k.toLowerCase());
  if (primaryKw) {
    const titleLower = title.toLowerCase();
    const slugLower = slug.toLowerCase();
    const metaTitleLower = effectiveMetaTitle(input).toLowerCase();
    const metaDescLower = effectiveMetaDescription(input).toLowerCase();
    const excerptLower = input.excerpt.toLowerCase();
    const bodyLower = input.body.toLowerCase();

    // First paragraph = body up to the first blank line (or first 400 chars
    // if the body has no break). Google weights early-body terms heavily.
    const firstParaEnd = bodyLower.search(/\n\s*\n/);
    const firstPara = firstParaEnd > -1 ? bodyLower.slice(0, firstParaEnd) : bodyLower.slice(0, 400);

    // H2 lines.
    const h2Lines = input.body.split("\n").filter((l) => /^##\s/.test(l)).map((l) => l.toLowerCase());

    // Slug match — URL is a top-3 ranking signal Google still emphasises.
    // Slug uses hyphens not spaces, so normalise both sides.
    const slugAsPhrase = slugLower.replace(/-/g, " ");
    const kwSlugSafe = primaryKw.replace(/\s+/g, " ");
    if (slugAsPhrase.includes(kwSlugSafe) || kwSlugSafe.split(" ").every((w) => slugLower.includes(w))) {
      checks.push({ id: "kw_slug", label: "Keyword in URL slug", status: "pass", message: `Primary keyword (or all its words) present in the URL.`, group: "keyword_usage" });
    } else {
      checks.push({ id: "kw_slug", label: "Keyword in URL slug", status: "warn", message: `Primary keyword "${primaryKw}" not reflected in the URL slug. URLs are a strong ranking signal — keep keyword words in the slug.`, group: "keyword_usage" });
    }

    if (titleLower.includes(primaryKw)) {
      const titlePos = titleLower.indexOf(primaryKw);
      const earlyHalf = titlePos < titleLower.length / 2;
      checks.push({
        id: "kw_title",
        label: "Keyword in title",
        status: earlyHalf ? "pass" : "warn",
        message: earlyHalf
          ? `"${primaryKw}" front-loaded in the page title.`
          : `Primary keyword appears in the title but in the second half. Front-load it where natural for better CTR + ranking.`,
        group: "keyword_usage",
      });
    } else {
      checks.push({ id: "kw_title", label: "Keyword in title", status: "warn", message: `Primary keyword "${primaryKw}" missing from the title. Google weights titles heavily — fold it in if natural.`, group: "keyword_usage" });
    }

    if (metaTitleLower.includes(primaryKw)) {
      checks.push({ id: "kw_meta_title", label: "Keyword in meta title", status: "pass", message: `Appears in the effective meta title.`, group: "keyword_usage" });
    } else {
      checks.push({ id: "kw_meta_title", label: "Keyword in meta title", status: "warn", message: `Primary keyword missing from the effective meta title.`, group: "keyword_usage" });
    }

    if (metaDescLower.includes(primaryKw)) {
      checks.push({ id: "kw_meta_desc", label: "Keyword in meta description", status: "pass", message: `Appears in the effective meta description.`, group: "keyword_usage" });
    } else {
      checks.push({ id: "kw_meta_desc", label: "Keyword in meta description", status: "warn", message: `Primary keyword missing from the effective meta description.`, group: "keyword_usage" });
    }

    if (excerptLower.includes(primaryKw)) {
      checks.push({ id: "kw_excerpt", label: "Keyword in excerpt", status: "pass", message: `Appears in the excerpt.`, group: "keyword_usage" });
    } else {
      checks.push({ id: "kw_excerpt", label: "Keyword in excerpt", status: "warn", message: `Primary keyword missing from the excerpt.`, group: "keyword_usage" });
    }

    if (firstPara.includes(primaryKw)) {
      checks.push({ id: "kw_first_para", label: "Keyword in opening paragraph", status: "pass", message: `Appears in the first paragraph.`, group: "keyword_usage" });
    } else {
      checks.push({ id: "kw_first_para", label: "Keyword in opening paragraph", status: "warn", message: `Primary keyword missing from the opening paragraph. Google weights early-body terms — work it into the first 50-100 words.`, group: "keyword_usage" });
    }

    // H2 keyword — accept the primary keyword OR any target keyword variant.
    // Headlines should NEVER strict-match a verbose phrase like "how to
    // retrain as a digital marketer" — natural headings carry the topic
    // signal via variants (e.g. "Funded routes to retrain as a digital
    // marketer" still tells Google + the reader what the section's about).
    if (h2Lines.length === 0) {
      // separately flagged elsewhere
    } else {
      const h2WithAnyKw = h2Lines.filter((l) => allKws.some((k) => k && l.includes(k))).length;
      if (h2WithAnyKw >= 1) {
        checks.push({ id: "kw_h2", label: "Keyword (or variant) in an H2", status: "pass", message: `${h2WithAnyKw} of ${h2Lines.length} H2 headings carry a target keyword or variant.`, group: "keyword_usage" });
      } else {
        checks.push({ id: "kw_h2", label: "Keyword (or variant) in an H2", status: "warn", message: `No H2 carries any target keyword. At least one section heading should signal the topic.`, group: "keyword_usage" });
      }
    }

    // Density — sum primary + variant occurrences, divide by word count.
    // 0.5-2.5% is the modern sweet spot; lower = thin / off-topic, higher
    // = stuffing / spammy.
    const variantCount = allKws.reduce((acc, k) => acc + countOccurrences(bodyLower, k), 0);
    const bodyWords = words; // already computed earlier
    const densityPct = bodyWords > 0 ? (variantCount / bodyWords) * 100 : 0;
    if (bodyWords < 100) {
      // body too short — skip; flagged elsewhere
    } else if (densityPct < 0.3) {
      checks.push({
        id: "kw_density",
        label: "Keyword density",
        status: "warn",
        message: `${variantCount} mentions across ${bodyWords} words (${densityPct.toFixed(2)}%). Thin — Google may not classify this post as topically focused. Aim for 0.5-2.5%.`,
        group: "keyword_usage",
      });
    } else if (densityPct > 3.5) {
      checks.push({
        id: "kw_density",
        label: "Keyword density",
        status: "warn",
        message: `${variantCount} mentions in ${bodyWords} words (${densityPct.toFixed(2)}%). High enough to look like stuffing. Keep under 3% by rotating variants.`,
        group: "keyword_usage",
      });
    } else {
      checks.push({
        id: "kw_density",
        label: "Keyword density",
        status: "pass",
        message: `${variantCount} mentions / ${bodyWords} words (${densityPct.toFixed(2)}%). Healthy.`,
        group: "keyword_usage",
      });
    }
  } else {
    checks.push({ id: "kw_none_set", label: "Keyword usage checks", status: "info", message: "Set a target keyword to enable keyword-placement checks.", group: "keyword_usage" });
  }

  // ---- Readability ---------------------------------------------------------
  // Google's helpful-content ranking + AI Overview retrieval both reward
  // posts with short sentences, scannable paragraphs, and a clean heading
  // ladder. Our editorial voice is conversational, so the bar is light:
  // we just flag the obvious offenders.

  const prose = stripMarkdown(input.body);
  const sentences = sentencesOf(prose);
  const paragraphs = paragraphsOf(input.body);

  if (sentences.length > 0) {
    const totalWords = sentences.reduce((acc, s) => acc + s.split(/\s+/).length, 0);
    const avgSentLen = totalWords / sentences.length;
    const longSentences = sentences.filter((s) => s.split(/\s+/).length > 30).length;
    if (avgSentLen > 24) {
      checks.push({
        id: "sentence_length_avg",
        label: "Average sentence length",
        status: "warn",
        message: `${avgSentLen.toFixed(1)} words/sentence — long for editorial prose. Aim for 14-22 average; long sentences hurt scan + AI passage retrieval.`,
        group: "readability",
      });
    } else {
      checks.push({
        id: "sentence_length_avg",
        label: "Average sentence length",
        status: "pass",
        message: `${avgSentLen.toFixed(1)} words/sentence. Healthy for scan + Google's NLP.`,
        group: "readability",
      });
    }
    if (longSentences > 0) {
      const limit = Math.max(2, Math.round(sentences.length * 0.1));
      const status: CheckStatus = longSentences > limit ? "warn" : "info";
      checks.push({
        id: "long_sentences",
        label: "Long sentences (>30 words)",
        status,
        message: `${longSentences} sentence${longSentences === 1 ? "" : "s"} over 30 words. Break them up — readers skim; AI Overviews pull short passages.`,
        group: "readability",
      });
    }
  }

  if (paragraphs.length > 0) {
    const longParas = paragraphs.filter((p) => {
      const sentenceCount = sentencesOf(stripMarkdown(p)).length;
      return sentenceCount >= 5;
    }).length;
    if (longParas === 0) {
      checks.push({
        id: "paragraph_length",
        label: "Paragraph length",
        status: "pass",
        message: `No paragraph runs over 4 sentences. Scannable.`,
        group: "readability",
      });
    } else {
      checks.push({
        id: "paragraph_length",
        label: "Paragraph length",
        status: "warn",
        message: `${longParas} paragraph${longParas === 1 ? "" : "s"} run 5+ sentences. Break them up — short paragraphs read better on mobile and lift dwell time.`,
        group: "readability",
      });
    }
  }

  const hierarchy = headingHierarchy(input.body);
  if (!hierarchy.ok) {
    checks.push({
      id: "heading_hierarchy",
      label: "Heading hierarchy",
      status: "warn",
      message: `Heading levels skipped (${hierarchy.jumps.join(", ")}). H2 → H3 → H4 should never jump. Confuses screen readers + Google's structure parsing.`,
      group: "readability",
    });
  } else {
    const h3Count = input.body.split("\n").filter((l) => /^###\s/.test(l)).length;
    checks.push({
      id: "heading_hierarchy",
      label: "Heading hierarchy",
      status: "pass",
      message: `Clean H2 → H3 nesting (${h2Count(input.body)} H2s, ${h3Count} H3s).`,
      group: "readability",
    });
  }

  // ---- AEO + retrieval ----------------------------------------------------
  // How well-shaped this post is for AI search engines (Google AI Overview,
  // Perplexity, ChatGPT search) to retrieve and CITE as their answer. The
  // signals here aren't classical SEO — they're whether the page is built
  // as a series of self-contained, structured answer passages.

  const h2Headings = input.body
    .split("\n")
    .filter((l) => /^##\s/.test(l))
    .map((l) => l.replace(/^##\s+/, "").trim());

  // Question-style H2s. AI engines pattern-match queries against headings.
  // Question phrasing ("What is X?", "How do I Y?", "How much does Z cost?")
  // wins.
  const questionH2Re = /^(what|how|why|when|where|who|which|can|should|does|do|is|are|will)\b|\?$/i;
  const questionH2Count = h2Headings.filter((h) => questionH2Re.test(h)).length;
  if (h2Headings.length === 0) {
    // separately flagged
  } else if (questionH2Count >= 3) {
    checks.push({
      id: "question_h2",
      label: "Question-style H2s",
      status: "pass",
      message: `${questionH2Count} of ${h2Headings.length} H2s are question-style. Strong AI Overview signal.`,
      group: "aeo",
    });
  } else if (questionH2Count >= 1) {
    checks.push({
      id: "question_h2",
      label: "Question-style H2s",
      status: "warn",
      message: `${questionH2Count} of ${h2Headings.length} H2s are question-style. Aim for 3+ to boost AI Overview + Perplexity retrieval.`,
      group: "aeo",
    });
  } else {
    checks.push({
      id: "question_h2",
      label: "Question-style H2s",
      status: "warn",
      message: `No H2s are phrased as questions. AI engines match natural-language queries against headings — switch 3+ H2s to question form ("How does X work?", "Who qualifies for Y?") where natural.`,
      group: "aeo",
    });
  }

  // Direct-answer snippet after each H2 — the 1-3 sentences immediately after
  // an H2 should be short and self-contained. AI Overviews lift these.
  const h2Blocks = (() => {
    const lines = input.body.split("\n");
    const blocks: Array<{ heading: string; firstParagraph: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) {
        const heading = lines[i].replace(/^##\s+/, "").trim();
        // Walk forward to find the first non-empty, non-heading paragraph.
        let para = "";
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j].trim();
          if (l === "" && para !== "") break;
          if (/^#{2,6}\s/.test(l)) break;
          if (l !== "") para += (para ? " " : "") + l;
        }
        blocks.push({ heading, firstParagraph: stripMarkdown(para) });
      }
    }
    return blocks;
  })();
  if (h2Blocks.length > 0) {
    const concise = h2Blocks.filter((b) => {
      const sc = sentencesOf(b.firstParagraph).length;
      return sc >= 1 && sc <= 3;
    }).length;
    const ratio = concise / h2Blocks.length;
    if (ratio >= 0.75) {
      checks.push({
        id: "answer_snippet",
        label: "Direct-answer snippet after each H2",
        status: "pass",
        message: `${concise} of ${h2Blocks.length} H2s open with a 1-3 sentence answer. AI Overviews can lift these verbatim.`,
        group: "aeo",
      });
    } else {
      checks.push({
        id: "answer_snippet",
        label: "Direct-answer snippet after each H2",
        status: "warn",
        message: `${concise} of ${h2Blocks.length} H2s open with a concise 1-3 sentence answer. Rewrite long openers so the first 1-3 sentences answer the heading on their own (then expand below).`,
        group: "aeo",
      });
    }
  }

  // Definitional opener — first paragraph short + contains the primary entity.
  const firstBodyPara = paragraphs[0] ?? "";
  if (firstBodyPara && primaryKw) {
    const sentCount = sentencesOf(stripMarkdown(firstBodyPara)).length;
    const containsKw = firstBodyPara.toLowerCase().includes(primaryKw);
    if (sentCount <= 3 && containsKw) {
      checks.push({
        id: "definitional_opener",
        label: "Definitional opener",
        status: "pass",
        message: `Opening paragraph is ${sentCount} sentence${sentCount === 1 ? "" : "s"} and names the primary entity. Good fit for AI definitional retrieval.`,
        group: "aeo",
      });
    } else {
      const why: string[] = [];
      if (sentCount > 3) why.push(`${sentCount} sentences (aim for ≤3)`);
      if (!containsKw) why.push(`primary keyword absent`);
      checks.push({
        id: "definitional_opener",
        label: "Definitional opener",
        status: "warn",
        message: `Opening paragraph: ${why.join("; ")}. The first paragraph should define the primary entity in ≤3 sentences — that's what AI engines lift for definitional queries.`,
        group: "aeo",
      });
    }
  }

  // TL;DR / Quick answer block at the top.
  const hasTldr = /^>\s*\*\*(quick answer|tl;dr|in short|summary)\*\*/im.test(input.body);
  if (hasTldr) {
    checks.push({
      id: "tldr_block",
      label: "Quick-answer block at top",
      status: "pass",
      message: `Quick-answer block found. AI engines surface these as the canonical short answer.`,
      group: "aeo",
    });
  } else {
    checks.push({
      id: "tldr_block",
      label: "Quick-answer block at top",
      status: "info",
      message: `No TL;DR / Quick-answer block. Optional, but a 2-3 sentence \`> **Quick answer:** ...\` at the top gets lifted by Google AI Overview + Perplexity. Recommended for posts with a short summary answer.`,
      group: "aeo",
    });
  }

  // Tables for comparative / numeric data.
  const tableCount = (input.body.match(/^\|.+\|$/gm) ?? []).filter((l, i, arr) => {
    // Only count rows that look like header rows (followed by a separator
    // `| --- | --- |`).
    return arr[i + 1] && /^\|[\s:-]+\|/.test(arr[i + 1] ?? "");
  }).length;
  if (tableCount >= 1) {
    checks.push({
      id: "tables_present",
      label: "Tables present",
      status: "pass",
      message: `${tableCount} table${tableCount === 1 ? "" : "s"} found. AI engines retrieve structured data far more readily than prose.`,
      group: "aeo",
    });
  } else {
    checks.push({
      id: "tables_present",
      label: "Tables present",
      status: "info",
      message: `No tables in the body. If this post compares schemes, salary bands, eligibility criteria, or duration windows, add a markdown table — AI engines lift them as answers.`,
      group: "aeo",
    });
  }

  // FAQ block. The build script picks up ```faq fenced blocks and renders
  // them as visible FAQ + JSON-LD FAQPage schema.
  const hasFaqBlock = /```faq[\s\S]*?```/m.test(input.body);
  if (hasFaqBlock) {
    checks.push({
      id: "faq_block",
      label: "FAQ block (FAQPage schema)",
      status: "pass",
      message: `FAQ block detected. Build emits FAQPage JSON-LD — Google + AI engines surface as rich snippets.`,
      group: "aeo",
    });
  } else {
    checks.push({
      id: "faq_block",
      label: "FAQ block (FAQPage schema)",
      status: "info",
      message: `No FAQ block. If the topic has 3-5 common questions, add a \`\`\`faq fenced block — build renders it as visible FAQ + FAQPage schema (Google rich snippet).`,
      group: "aeo",
    });
  }

  // Numbered/HowTo lists for procedural topics.
  const hasNumberedSteps = /^\d+\.\s/m.test(input.body) && (input.body.match(/^\d+\.\s/gm) ?? []).length >= 3;
  if (hasNumberedSteps) {
    checks.push({
      id: "howto_steps",
      label: "Numbered steps (HowTo signal)",
      status: "pass",
      message: `Numbered steps detected. AI engines retrieve these as HowTo schema candidates.`,
      group: "aeo",
    });
  }

  // ---- Social / OG ---------------------------------------------------------

  const cover = input.cover_image_url.trim();
  if (!cover) {
    checks.push({ id: "cover_image", label: "Cover image", status: "warn", message: "Missing. Required for OG social cards and recommended for blog listings (1200×630 minimum for Facebook/Twitter share).", group: "social" });
  } else {
    checks.push({ id: "cover_image", label: "Cover image", status: "pass", message: cover, group: "social" });
    if (!input.cover_image_alt.trim()) {
      checks.push({ id: "cover_image_alt", label: "Cover image alt", status: "fail", message: "Cover URL is set but alt text is empty. Required for accessibility + image SEO.", group: "social" });
    } else {
      checks.push({ id: "cover_image_alt", label: "Cover image alt", status: "pass", message: `${input.cover_image_alt.length} chars`, group: "social" });
    }
  }

  // ---- Effective defaults (info — show what will actually render) ----------

  const eMetaTitle = effectiveMetaTitle(input);
  if (eMetaTitle) {
    const len = eMetaTitle.length;
    const source = input.meta_title.trim() ? "explicit" : "from title";
    const status: CheckStatus = len > 60 ? "warn" : len < 30 ? "warn" : "info";
    const msg = len > 60
      ? `${len} chars (${source}) — Google truncates past ~60.`
      : len < 30
        ? `${len} chars (${source}) — quite short for the Google tab.`
        : `${len} chars (${source}). Ideal 50-60.`;
    checks.push({ id: "meta_title_effective", label: "Meta title (effective)", status, message: msg, group: "defaults" });
  }

  const eMetaDesc = effectiveMetaDescription(input);
  if (eMetaDesc) {
    const len = eMetaDesc.length;
    const source = input.meta_description.trim() ? "explicit" : "from excerpt";
    const status: CheckStatus = len > 160 ? "warn" : len < 100 ? "warn" : "info";
    const msg = len > 160
      ? `${len} chars (${source}) — Google truncates past ~160.`
      : len < 100
        ? `${len} chars (${source}) — pad to 140-160 for a fuller snippet.`
        : `${len} chars (${source}). Ideal 140-160.`;
    checks.push({ id: "meta_description_effective", label: "Meta description (effective)", status, message: msg, group: "defaults" });
  } else {
    checks.push({ id: "meta_description_missing", label: "Meta description (effective)", status: "warn", message: "Empty — Google will write its own snippet. Add an excerpt or explicit meta description.", group: "defaults" });
  }

  const eOgTitle = effectiveOgTitle(input);
  if (eOgTitle) {
    const source = input.og_title.trim() ? "explicit" : "from meta title / title";
    checks.push({ id: "og_title_effective", label: "OG title (effective)", status: "info", message: `${eOgTitle.length} chars (${source}).`, group: "defaults" });
  }

  const eOgDesc = effectiveOgDescription(input);
  if (eOgDesc) {
    const source = input.og_description.trim() ? "explicit" : "from meta description / excerpt";
    checks.push({ id: "og_desc_effective", label: "OG description (effective)", status: "info", message: `${eOgDesc.length} chars (${source}).`, group: "defaults" });
  }

  const eOgImg = effectiveOgImage(input);
  if (eOgImg) {
    const source = input.og_image_url.trim() ? "explicit" : "from cover image";
    checks.push({ id: "og_image_effective", label: "OG image (effective)", status: "info", message: `${eOgImg} (${source}).`, group: "defaults" });
  } else {
    checks.push({ id: "og_image_missing", label: "OG image (effective)", status: "warn", message: "No image set. Social shares will fall back to the site default — bland.", group: "defaults" });
  }

  const eCanonical = effectiveCanonical(input);
  if (eCanonical) {
    const source = input.canonical_url.trim() ? "explicit (manual)" : "auto from slug";
    const status: CheckStatus = input.canonical_url.trim() ? "warn" : "info";
    const msg = input.canonical_url.trim()
      ? `${eCanonical} (${source}) — manual canonical is uncommon. Only use when this URL is a republish of content that lives elsewhere.`
      : `${eCanonical} (${source}).`;
    checks.push({ id: "canonical_effective", label: "Canonical URL (effective)", status, message: msg, group: "defaults" });
  }

  return checks;
}

export function checkSeoSummary(checks: SeoCheck[]) {
  const counts = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const c of checks) counts[c.status]++;
  const blockingPublish = counts.fail > 0;
  return { ...counts, blockingPublish };
}
