// SEO + social best-practice rules for the blog CMS editor.
//
// Pure function: takes PostFormInput, returns a list of checks. The editor
// rail renders the result and the preview page surfaces a compact summary.
// Each rule documents the convention behind its threshold so future-Claude
// (and the next editor) can challenge them.
//
// What this DOESN'T cover (handled by the build script — Mable's domain):
//   - Emitting <meta>, OG, Twitter card tags in the rendered HTML
//   - JSON-LD Article schema
//   - Default-fallback resolution (meta_title → title, og_image → cover, etc.)
//   - Canonical URL auto-generation from slug
//   - Sitemap inclusion (already handled by scripts/build-sitemap.js)
//
// The checklist tells Charlotte WHEN a default kicks in (info status) so she
// knows the effective value even before the build runs.

import type { PostFormInput } from "./actions";

export type CheckStatus = "pass" | "warn" | "fail" | "info";
export type CheckGroup = "required" | "on_page" | "social" | "defaults";

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

function countMarkdownLinks(body: string): { internal: number; external: number } {
  // Markdown links: [text](url). Doesn't catch reference-style links — those
  // are rare in our content; can be added later if needed.
  const matches = body.match(/\]\(([^)]+)\)/g) ?? [];
  let internal = 0;
  let external = 0;
  for (const m of matches) {
    const url = m.slice(2, -1).trim();
    if (!url || url.startsWith("#") || url.startsWith("mailto:")) continue;
    if (url.startsWith("/") || url.includes("switchable.org.uk")) internal++;
    else external++;
  }
  return { internal, external };
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
  } else if (title.length > 70) {
    checks.push({ id: "title_too_long", label: "Title length", status: "warn", message: `${title.length} chars — Google truncates titles past ~60 chars in results.`, group: "required" });
  } else if (title.length < 30) {
    checks.push({ id: "title_short", label: "Title length", status: "warn", message: `${title.length} chars — shorter titles often underperform. 40-60 is the sweet spot.`, group: "required" });
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
    checks.push({ id: "internal_links", label: "Internal links", status: "warn", message: `${links.internal} internal link — add 1-2 more for stronger crawl + reader path.`, group: "on_page" });
  } else {
    checks.push({ id: "internal_links", label: "Internal links", status: "pass", message: `${links.internal} internal · ${links.external} external`, group: "on_page" });
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
