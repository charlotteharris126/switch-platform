"use server";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Server Actions for /admin/blog CRUD against editorial.posts.
//
// Architecture: uses the authenticated server client + admin RLS gates on
// editorial.posts (admin_write_posts policy from migration 0163) rather than
// the Edge Function pattern used by /admin/roadmap. Reason: editorial.posts
// writes don't need elevated permissions or cross-schema access — RLS is
// the right gate. Every action also re-checks isAdmin() at the top so a
// non-admin authenticated user gets a clear error instead of a silent RLS
// rejection.
//
// Slug uniqueness is enforced by the UNIQUE constraint on editorial.posts.slug.
// Status workflow: draft → scheduled → published → archived (archive doesn't
// delete; preserves history). Delete is permanent and only allowed on drafts
// to avoid accidentally nuking live SEO content.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/allowlist";

export type PostStatus = "draft" | "scheduled" | "published" | "archived";

export type Post = {
  id: number;
  slug: string;
  title: string;
  dek: string | null;
  excerpt: string | null;
  body: string;
  category_id: string | null;
  status: PostStatus;
  publish_date: string | null;
  reading_time_minutes: number | null;
  cover_image_url: string | null;
  cover_image_alt: string | null;
  featured: boolean;
  lead_magnet_enabled: boolean;
  meta_title: string | null;
  meta_description: string | null;
  og_title: string | null;
  og_description: string | null;
  og_image_url: string | null;
  canonical_url: string | null;
  target_keywords: string[];
  internal_links: string[];
  related_courses: string[];
  end_cta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type PostFormInput = {
  slug: string;
  title: string;
  dek: string;
  excerpt: string;
  body: string;
  category_id: string;
  status: PostStatus;
  publish_date: string;
  cover_image_url: string;
  cover_image_alt: string;
  featured: boolean;
  lead_magnet_enabled: boolean;
  meta_title: string;
  meta_description: string;
  og_title: string;
  og_description: string;
  og_image_url: string;
  canonical_url: string;
  target_keywords: string;
  tags: string;
};

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function getAdminSupabase() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user || !isAdmin(userData.user.email)) {
    return { ok: false as const, error: "Not authorised" };
  }
  return { ok: true as const, supabase, userId: userData.user.id };
}

function readingTimeFromBody(body: string): number {
  // 220 words per minute is the conventional reading-time constant.
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function validateInput(input: PostFormInput): string | null {
  if (!input.slug.trim()) return "Slug is required";
  if (!SLUG_RE.test(input.slug.trim())) {
    return "Slug must be lowercase letters / numbers / hyphens (e.g. how-to-change-career-uk)";
  }
  if (!input.title.trim()) return "Title is required";
  if (input.title.length > 200) return "Title is too long (200 char max)";
  if (input.dek && input.dek.length > 300) return "Dek is too long (300 char max)";
  if (!input.body.trim()) return "Body is required (even one paragraph)";
  if (!["draft", "scheduled", "published", "archived"].includes(input.status)) {
    return "Invalid status";
  }
  if ((input.status === "scheduled" || input.status === "published") && !input.publish_date) {
    return "Publish date is required for scheduled or published posts";
  }
  return null;
}

export async function listPostsAction(): Promise<ActionResult<Post[]>> {
  const gate = await getAdminSupabase();
  if (!gate.ok) return gate;

  const { data, error } = await gate.supabase
    .schema("editorial")
    .from("posts")
    .select("*")
    .order("status", { ascending: true })
    .order("publish_date", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false });

  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data ?? []) as Post[] };
}

export async function getPostBySlugAction(slug: string): Promise<ActionResult<{ post: Post; tagSlugs: string[] }>> {
  const gate = await getAdminSupabase();
  if (!gate.ok) return gate;

  const { data: post, error } = await gate.supabase
    .schema("editorial")
    .from("posts")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!post) return { ok: false, error: "Post not found" };

  const { data: postTags } = await gate.supabase
    .schema("editorial")
    .from("post_tags")
    .select("tag_id, tags:tag_id(slug)")
    .eq("post_id", post.id);

  const tagSlugs = (postTags ?? [])
    .map((row) => (row.tags as unknown as { slug: string } | null)?.slug)
    .filter((s): s is string => typeof s === "string");

  return { ok: true, data: { post: post as Post, tagSlugs } };
}

async function syncTags(
  supabase: any,
  postId: number,
  tagSlugs: string[],
): Promise<string | null> {
  // Look up tag IDs for the supplied slugs. Unknown tag slugs are silently
  // ignored — Charlotte's tag-create UI lands in a later session; for now
  // only tags that already exist in the registry can be applied.
  if (tagSlugs.length === 0) {
    const { error } = await supabase.schema("editorial").from("post_tags").delete().eq("post_id", postId);
    return error?.message ?? null;
  }

  const { data: tagRows, error: tagErr } = await supabase
    .schema("editorial")
    .from("tags")
    .select("id, slug")
    .in("slug", tagSlugs);

  if (tagErr) return tagErr.message;
  const tagIds = (tagRows ?? []).map((r: any) => r.id as number);

  // Wipe + re-insert. Cheap at our row counts and simpler than reconciling
  // diffs. The junction table has ON DELETE CASCADE so the FK survives.
  const { error: delErr } = await supabase
    .schema("editorial")
    .from("post_tags")
    .delete()
    .eq("post_id", postId);
  if (delErr) return delErr.message;

  if (tagIds.length > 0) {
    const { error: insErr } = await supabase
      .schema("editorial")
      .from("post_tags")
      .insert(tagIds.map((tagId: number) => ({ post_id: postId, tag_id: tagId })));
    if (insErr) return insErr.message;
  }

  return null;
}

export async function createPostAction(input: PostFormInput): Promise<ActionResult<{ slug: string }>> {
  const gate = await getAdminSupabase();
  if (!gate.ok) return gate;

  const validation = validateInput(input);
  if (validation) return { ok: false, error: validation };

  const row = {
    slug: input.slug.trim(),
    title: input.title.trim(),
    dek: input.dek.trim() || null,
    excerpt: input.excerpt.trim() || null,
    body: input.body,
    category_id: input.category_id || null,
    status: input.status,
    publish_date: input.publish_date || null,
    reading_time_minutes: readingTimeFromBody(input.body),
    cover_image_url: input.cover_image_url.trim() || null,
    cover_image_alt: input.cover_image_alt.trim() || null,
    featured: input.featured,
    lead_magnet_enabled: input.lead_magnet_enabled,
    meta_title: input.meta_title.trim() || null,
    meta_description: input.meta_description.trim() || null,
    og_title: input.og_title.trim() || null,
    og_description: input.og_description.trim() || null,
    og_image_url: input.og_image_url.trim() || null,
    canonical_url: input.canonical_url.trim() || null,
    target_keywords: parseCsv(input.target_keywords),
    author_id: gate.userId,
  };

  const { data: inserted, error } = await gate.supabase
    .schema("editorial")
    .from("posts")
    .insert(row)
    .select("id, slug")
    .single();

  if (error) return { ok: false, error: error.message };

  const tagSlugs = parseCsv(input.tags);
  const tagErr = await syncTags(gate.supabase, inserted.id as number, tagSlugs);
  if (tagErr) return { ok: false, error: `Post saved but tag sync failed: ${tagErr}` };

  revalidatePath("/admin/blog");
  return { ok: true, data: { slug: inserted.slug as string } };
}

export async function updatePostAction(
  originalSlug: string,
  input: PostFormInput,
): Promise<ActionResult<{ slug: string }>> {
  const gate = await getAdminSupabase();
  if (!gate.ok) return gate;

  const validation = validateInput(input);
  if (validation) return { ok: false, error: validation };

  const { data: existing, error: lookupErr } = await gate.supabase
    .schema("editorial")
    .from("posts")
    .select("id")
    .eq("slug", originalSlug)
    .maybeSingle();

  if (lookupErr) return { ok: false, error: lookupErr.message };
  if (!existing) return { ok: false, error: "Post not found" };

  const patch = {
    slug: input.slug.trim(),
    title: input.title.trim(),
    dek: input.dek.trim() || null,
    excerpt: input.excerpt.trim() || null,
    body: input.body,
    category_id: input.category_id || null,
    status: input.status,
    publish_date: input.publish_date || null,
    reading_time_minutes: readingTimeFromBody(input.body),
    cover_image_url: input.cover_image_url.trim() || null,
    cover_image_alt: input.cover_image_alt.trim() || null,
    featured: input.featured,
    lead_magnet_enabled: input.lead_magnet_enabled,
    meta_title: input.meta_title.trim() || null,
    meta_description: input.meta_description.trim() || null,
    og_title: input.og_title.trim() || null,
    og_description: input.og_description.trim() || null,
    og_image_url: input.og_image_url.trim() || null,
    canonical_url: input.canonical_url.trim() || null,
    target_keywords: parseCsv(input.target_keywords),
    last_modified: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { error } = await gate.supabase
    .schema("editorial")
    .from("posts")
    .update(patch)
    .eq("id", existing.id);

  if (error) return { ok: false, error: error.message };

  const tagSlugs = parseCsv(input.tags);
  const tagErr = await syncTags(gate.supabase, existing.id as number, tagSlugs);
  if (tagErr) return { ok: false, error: `Post saved but tag sync failed: ${tagErr}` };

  revalidatePath("/admin/blog");
  revalidatePath(`/admin/blog/${patch.slug}/edit`);
  return { ok: true, data: { slug: patch.slug } };
}

export async function deletePostAction(slug: string): Promise<ActionResult<{ slug: string }>> {
  const gate = await getAdminSupabase();
  if (!gate.ok) return gate;

  const { data: existing, error: lookupErr } = await gate.supabase
    .schema("editorial")
    .from("posts")
    .select("id, status")
    .eq("slug", slug)
    .maybeSingle();

  if (lookupErr) return { ok: false, error: lookupErr.message };
  if (!existing) return { ok: false, error: "Post not found" };
  if (existing.status !== "draft") {
    return { ok: false, error: "Only drafts can be deleted. Archive published posts instead." };
  }

  const { error } = await gate.supabase
    .schema("editorial")
    .from("posts")
    .delete()
    .eq("id", existing.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/admin/blog");
  return { ok: true, data: { slug } };
}

export async function listCategoriesAction(): Promise<ActionResult<Array<{ id: string; name: string }>>> {
  const gate = await getAdminSupabase();
  if (!gate.ok) return gate;

  const { data, error } = await gate.supabase
    .schema("editorial")
    .from("categories")
    .select("id, name")
    .order("name", { ascending: true });

  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data ?? []) as Array<{ id: string; name: string }> };
}

export async function listTagsAction(): Promise<ActionResult<Array<{ slug: string; name: string }>>> {
  const gate = await getAdminSupabase();
  if (!gate.ok) return gate;

  const { data, error } = await gate.supabase
    .schema("editorial")
    .from("tags")
    .select("slug, name")
    .order("name", { ascending: true });

  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data ?? []) as Array<{ slug: string; name: string }> };
}
