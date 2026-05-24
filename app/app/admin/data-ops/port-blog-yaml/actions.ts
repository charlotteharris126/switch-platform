"use server";

/* eslint-disable @typescript-eslint/no-explicit-any */

// One-shot: port the 4 launch-set blog drafts into editorial.posts.
//
// Source is platform/app/data/blog-launch-set.json, pre-converted from the
// 4 YAML files in switchable/site/deploy/data/posts/ (the platform/app
// Netlify deploy doesn't carry switchable/site files, so the YAMLs were
// converted at build authoring time).
//
// Idempotent: skips any slug already in editorial.posts. Re-runs are safe.
// After all 4 land in the CMS, this whole route can be deleted along with
// data/blog-launch-set.json — it's throwaway scaffolding for the YAML→DB
// cutover. Mirrors the data-ops admin panel pattern (no terminal, no env
// vars, no password copying — operator clicks a button on /admin).

import path from "node:path";
import { readFile } from "node:fs/promises";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/allowlist";

export interface PortPostResult {
  slug: string;
  outcome: "ported" | "skipped_already_exists" | "failed";
  post_id?: number;
  tags_linked?: number;
  unknown_tags?: string[];
  error?: string;
}

export interface PortBlogYamlSummary {
  ok: true;
  total: number;
  ported: number;
  skipped: number;
  failed: number;
  results: PortPostResult[];
}

export type PortBlogYamlResult = PortBlogYamlSummary | { ok: false; error: string };

interface LaunchSetPost {
  sourceFile: string;
  slug: string;
  status?: string;
  title: string;
  dek?: string | null;
  excerpt?: string | null;
  body?: string;
  category?: string | null;
  publish_date?: string | null;
  reading_time_minutes?: number | null;
  cover_image?: string | null;
  cover_image_alt?: string | null;
  featured?: boolean;
  lead_magnet_enabled?: boolean;
  tags?: string[];
  target_keywords?: string[];
  internal_links?: string[];
  related_courses?: string[];
  end_cta?: Record<string, unknown> | null;
  seo?: {
    meta_title?: string | null;
    meta_description?: string | null;
    og_title?: string | null;
    og_description?: string | null;
    og_image?: string | null;
    canonical?: string | null;
  };
}

function readingTimeFromBody(body: string): number {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

export async function portBlogYamlAction(): Promise<PortBlogYamlResult> {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user || !isAdmin(userData.user.email)) {
    return { ok: false, error: "Not authorised" };
  }

  let posts: LaunchSetPost[];
  try {
    const raw = await readFile(
      path.join(process.cwd(), "data", "blog-launch-set.json"),
      "utf8",
    );
    posts = JSON.parse(raw) as LaunchSetPost[];
  } catch (err) {
    return {
      ok: false,
      error: `Could not read blog-launch-set.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Pre-load tag slug → id map (16 seeded rows from migration 0163).
  const { data: tagRows, error: tagErr } = await supabase
    .schema("editorial")
    .from("tags")
    .select("id, slug");
  if (tagErr) return { ok: false, error: `Could not load tags: ${tagErr.message}` };
  const tagIdBySlug = new Map<string, number>();
  for (const t of (tagRows ?? []) as Array<{ id: number; slug: string }>) {
    tagIdBySlug.set(t.slug, t.id);
  }

  const results: PortPostResult[] = [];

  for (const p of posts) {
    const slug = String(p.slug ?? "").trim();
    if (!slug || !p.title) {
      results.push({
        slug: slug || `(no slug: ${p.sourceFile})`,
        outcome: "failed",
        error: "Missing slug or title",
      });
      continue;
    }

    const { data: existing } = await supabase
      .schema("editorial")
      .from("posts")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();

    if (existing) {
      results.push({ slug, outcome: "skipped_already_exists" });
      continue;
    }

    const body = typeof p.body === "string" ? p.body : "";
    const readingTime = p.reading_time_minutes ?? readingTimeFromBody(body);
    const status = ["draft", "scheduled", "published", "archived"].includes(p.status ?? "")
      ? (p.status as string)
      : "draft";

    const row = {
      slug,
      title: String(p.title),
      dek: p.dek ?? null,
      excerpt: p.excerpt ?? null,
      body,
      category_id: p.category ?? null,
      status,
      publish_date: p.publish_date ?? null,
      reading_time_minutes: readingTime,
      cover_image_url: p.cover_image ?? null,
      cover_image_alt: p.cover_image_alt ?? null,
      featured: p.featured === true,
      lead_magnet_enabled: p.lead_magnet_enabled !== false,
      meta_title: p.seo?.meta_title ?? null,
      meta_description: p.seo?.meta_description ?? null,
      og_title: p.seo?.og_title ?? null,
      og_description: p.seo?.og_description ?? null,
      og_image_url: p.seo?.og_image ?? null,
      canonical_url: p.seo?.canonical ?? null,
      target_keywords: Array.isArray(p.target_keywords) ? p.target_keywords : [],
      internal_links: Array.isArray(p.internal_links) ? p.internal_links : [],
      related_courses: Array.isArray(p.related_courses) ? p.related_courses : [],
      end_cta: p.end_cta ?? { type: "course-finder" },
      author_id: userData.user.id,
    };

    const { data: inserted, error: insErr } = await supabase
      .schema("editorial")
      .from("posts")
      .insert(row)
      .select("id")
      .single();

    if (insErr || !inserted) {
      results.push({
        slug,
        outcome: "failed",
        error: insErr?.message ?? "INSERT returned no row",
      });
      continue;
    }

    const postId = inserted.id as number;
    const tagSlugs = Array.isArray(p.tags) ? p.tags : [];
    const validTagIds: number[] = [];
    const unknownTags: string[] = [];
    for (const t of tagSlugs) {
      const id = tagIdBySlug.get(String(t));
      if (id != null) validTagIds.push(id);
      else unknownTags.push(String(t));
    }

    if (validTagIds.length > 0) {
      const { error: linkErr } = await supabase
        .schema("editorial")
        .from("post_tags")
        .upsert(
          validTagIds.map((tagId) => ({ post_id: postId, tag_id: tagId })),
          { onConflict: "post_id,tag_id", ignoreDuplicates: true },
        );
      if (linkErr) {
        results.push({
          slug,
          outcome: "ported",
          post_id: postId,
          tags_linked: 0,
          unknown_tags: unknownTags,
          error: `Post inserted but tag link failed: ${linkErr.message}`,
        });
        continue;
      }
    }

    results.push({
      slug,
      outcome: "ported",
      post_id: postId,
      tags_linked: validTagIds.length,
      unknown_tags: unknownTags,
    });
  }

  const summary: PortBlogYamlSummary = {
    ok: true,
    total: posts.length,
    ported: results.filter((r) => r.outcome === "ported").length,
    skipped: results.filter((r) => r.outcome === "skipped_already_exists").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    results,
  };

  if (summary.ported > 0) revalidatePath("/admin/blog");
  return summary;
}
