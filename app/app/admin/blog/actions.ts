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
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/auth/allowlist";

// Fire-and-forget Netlify Build Hook trigger. Calls the SECURITY DEFINER
// Postgres function from migration 0167 which holds the hook URL in the
// vault — keeps the secret out of the Next.js process.
// Failures don't bubble: a missing vault entry or Netlify outage shouldn't
// block a save. The post is in the DB; the rebuild will happen on the next
// cron tick or push.
async function fireBuildHookOnPublish(
  supabase: Awaited<ReturnType<typeof createClient>>,
  reason: string,
): Promise<void> {
  try {
    await supabase.schema("editorial").rpc("fire_netlify_blog_build", { p_reason: reason });
  } catch (err) {
    console.warn("fire_netlify_blog_build failed (non-blocking):", err);
  }
}

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

  // Fire Netlify rebuild only if this lands as published — most creates are
  // drafts and don't need a rebuild.
  if (input.status === "published") {
    await fireBuildHookOnPublish(gate.supabase, `create-published: ${inserted.slug}`);
  }

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
    .select("id, status")
    .eq("slug", originalSlug)
    .maybeSingle();

  if (lookupErr) return { ok: false, error: lookupErr.message };
  if (!existing) return { ok: false, error: "Post not found" };

  const previousStatus = existing.status as string;

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

  // Fire rebuild on the transitions that change the live site:
  //   - any → published        (post goes live)
  //   - published → published  (live post edited — content change shipped)
  //   - published → archived   (post comes down)
  // Skip transitions between draft/scheduled (not on live site yet) and
  // archived → not-published edits (already not on live).
  const newStatus = input.status;
  const wasOnLive = previousStatus === "published";
  const isOnLive = newStatus === "published";
  if (isOnLive || (wasOnLive && newStatus === "archived")) {
    await fireBuildHookOnPublish(
      gate.supabase,
      `update: ${patch.slug} (${previousStatus} → ${newStatus})`,
    );
  }

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

// ── Tag CRUD + retroactive-apply ────────────────────────────────────────────
// Tag operations write to editorial.tags + editorial.post_tags. Same RLS gate
// as posts (admin_write_tags / admin_write_post_tags policies from 0163).

export type TagWithUsage = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  usage_count: number;
};

export async function listTagsWithUsageAction(): Promise<ActionResult<TagWithUsage[]>> {
  const gate = await getAdminSupabase();
  if (!gate.ok) return gate;

  // Two reads: tags + post_tags counts. Could be one with a join via RPC but
  // at our scale (16 tags × ~50 posts max) the round-trip is negligible.
  const { data: tagRows, error: tagErr } = await gate.supabase
    .schema("editorial")
    .from("tags")
    .select("id, slug, name, description")
    .order("name", { ascending: true });

  if (tagErr) return { ok: false, error: tagErr.message };

  const { data: ptRows, error: ptErr } = await gate.supabase
    .schema("editorial")
    .from("post_tags")
    .select("tag_id");

  if (ptErr) return { ok: false, error: ptErr.message };

  const usageByTag = new Map<number, number>();
  for (const row of (ptRows ?? []) as Array<{ tag_id: number }>) {
    usageByTag.set(row.tag_id, (usageByTag.get(row.tag_id) ?? 0) + 1);
  }

  const tags: TagWithUsage[] = ((tagRows ?? []) as Array<{ id: number; slug: string; name: string; description: string | null }>).map((t) => ({
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    usage_count: usageByTag.get(t.id) ?? 0,
  }));

  return { ok: true, data: tags };
}

const TAG_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function createTagAction(input: {
  slug: string;
  name: string;
  description: string;
}): Promise<ActionResult<{ id: number; slug: string }>> {
  const gate = await getAdminSupabase();
  if (!gate.ok) return gate;

  const slug = input.slug.trim();
  const name = input.name.trim();
  if (!slug) return { ok: false, error: "Slug is required" };
  if (!TAG_SLUG_RE.test(slug)) {
    return { ok: false, error: "Slug must be lowercase letters / numbers / hyphens" };
  }
  if (!name) return { ok: false, error: "Name is required" };

  const { data, error } = await gate.supabase
    .schema("editorial")
    .from("tags")
    .insert({ slug, name, description: input.description.trim() || null })
    .select("id, slug")
    .single();

  if (error) return { ok: false, error: error.message };

  revalidatePath("/admin/blog/tags");
  return { ok: true, data: { id: data.id as number, slug: data.slug as string } };
}

export async function updateTagAction(input: {
  id: number;
  slug: string;
  name: string;
  description: string;
}): Promise<ActionResult<{ id: number; slug: string }>> {
  const gate = await getAdminSupabase();
  if (!gate.ok) return gate;

  const slug = input.slug.trim();
  const name = input.name.trim();
  if (!slug) return { ok: false, error: "Slug is required" };
  if (!TAG_SLUG_RE.test(slug)) {
    return { ok: false, error: "Slug must be lowercase letters / numbers / hyphens" };
  }
  if (!name) return { ok: false, error: "Name is required" };

  const { error } = await gate.supabase
    .schema("editorial")
    .from("tags")
    .update({ slug, name, description: input.description.trim() || null })
    .eq("id", input.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/admin/blog/tags");
  return { ok: true, data: { id: input.id, slug } };
}

export async function deleteTagAction(id: number): Promise<ActionResult<{ id: number }>> {
  const gate = await getAdminSupabase();
  if (!gate.ok) return gate;

  // ON DELETE CASCADE on post_tags removes the relations automatically.
  // No need to deny if used — Charlotte may intentionally retire a tag.
  const { error } = await gate.supabase
    .schema("editorial")
    .from("tags")
    .delete()
    .eq("id", id);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/admin/blog/tags");
  return { ok: true, data: { id } };
}

export async function listPostsForRetroactiveTagAction(
  tagId: number,
): Promise<ActionResult<Array<{ id: number; slug: string; title: string; status: string; hasTag: boolean }>>> {
  const gate = await getAdminSupabase();
  if (!gate.ok) return gate;

  const { data: posts, error: postsErr } = await gate.supabase
    .schema("editorial")
    .from("posts")
    .select("id, slug, title, status")
    .neq("status", "archived")
    .order("status", { ascending: true })
    .order("publish_date", { ascending: false, nullsFirst: false });

  if (postsErr) return { ok: false, error: postsErr.message };

  const { data: ptRows, error: ptErr } = await gate.supabase
    .schema("editorial")
    .from("post_tags")
    .select("post_id")
    .eq("tag_id", tagId);

  if (ptErr) return { ok: false, error: ptErr.message };

  const taggedPostIds = new Set((ptRows ?? []).map((r) => (r as { post_id: number }).post_id));

  const out = (posts ?? []).map((p) => {
    const post = p as { id: number; slug: string; title: string; status: string };
    return {
      ...post,
      hasTag: taggedPostIds.has(post.id),
    };
  });

  return { ok: true, data: out };
}

export async function applyTagToPostsAction(
  tagId: number,
  postIds: number[],
): Promise<ActionResult<{ applied: number }>> {
  const gate = await getAdminSupabase();
  if (!gate.ok) return gate;

  if (postIds.length === 0) return { ok: true, data: { applied: 0 } };

  const { error } = await gate.supabase
    .schema("editorial")
    .from("post_tags")
    .upsert(
      postIds.map((postId) => ({ post_id: postId, tag_id: tagId })),
      { onConflict: "post_id,tag_id", ignoreDuplicates: true },
    );

  if (error) return { ok: false, error: error.message };

  revalidatePath("/admin/blog/tags");
  return { ok: true, data: { applied: postIds.length } };
}

export async function removeTagFromPostsAction(
  tagId: number,
  postIds: number[],
): Promise<ActionResult<{ removed: number }>> {
  const gate = await getAdminSupabase();
  if (!gate.ok) return gate;

  if (postIds.length === 0) return { ok: true, data: { removed: 0 } };

  const { error } = await gate.supabase
    .schema("editorial")
    .from("post_tags")
    .delete()
    .eq("tag_id", tagId)
    .in("post_id", postIds);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/admin/blog/tags");
  return { ok: true, data: { removed: postIds.length } };
}


// ── AI assist ────────────────────────────────────────────────────────────────
// Wraps blog-ai-assist Edge Function for the "Suggest" buttons in the editor.
// Read AUDIT_SHARED_SECRET from vault + POST per kind. Returns the suggestion
// shape that surface produces (string for outline/meta/excerpt; string[] for
// headlines/tags).

export type AiAssistKind = "outline" | "headlines" | "meta_description" | "excerpt" | "tags";

export type AiAssistInput = {
  kind: AiAssistKind;
  post: {
    title?: string;
    dek?: string | null;
    excerpt?: string | null;
    body?: string;
    category_id?: string | null;
    target_keywords?: string[];
    current_value?: string;
  };
  post_id?: number | null;
  post_slug?: string | null;
  known_tags?: Array<{ slug: string; name: string }>;
};

export type AiAssistResult =
  | {
      ok: true;
      suggestion: string | string[];
      usage: {
        input: number;
        output: number;
        cache_read: number;
        cache_creation: number;
        cost_usd: number;
        latency_ms: number;
        model: string;
      };
    }
  | { ok: false; error: string };

export async function aiAssistAction(input: AiAssistInput): Promise<AiAssistResult> {
  try {
    const gate = await getAdminSupabase();
    if (!gate.ok) return gate;

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!supabaseUrl) {
      return { ok: false, error: "Server misconfigured: NEXT_PUBLIC_SUPABASE_URL missing" };
    }

    const admin = createAdminClient();
    const { data: secretData, error: secretErr } = await admin.rpc("get_shared_secret", {
      p_name: "AUDIT_SHARED_SECRET",
    });
    if (secretErr || typeof secretData !== "string" || !secretData) {
      return {
        ok: false,
        error: `Could not read AUDIT_SHARED_SECRET: ${secretErr?.message ?? "no value"}`,
      };
    }

    let resp: Response;
    try {
      resp = await fetch(`${supabaseUrl}/functions/v1/blog-ai-assist`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-audit-key": secretData },
        body: JSON.stringify(input),
      });
    } catch (err) {
      return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
    }

    let body: AiAssistResult;
    try {
      body = (await resp.json()) as AiAssistResult;
    } catch {
      return { ok: false, error: `Edge Function ${resp.status}: non-JSON response` };
    }
    if (!resp.ok || !("ok" in body) || body.ok !== true) {
      const errMsg = !body.ok ? body.error : `Edge Function ${resp.status}`;
      return { ok: false, error: errMsg };
    }
    return body;
  } catch (err) {
    return { ok: false, error: `aiAssistAction threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Cover image upload (Supabase Storage) ────────────────────────────────────
// Uploads a file to the blog-media bucket. Returns the public URL so the
// editor can drop it straight into cover_image_url. Filenames are scoped by
// post slug (or 'misc/' for create-mode uploads before save) and made unique
// with a short content hash so repeat uploads don't overwrite earlier covers.

export type UploadResult =
  | { ok: true; public_url: string; storage_path: string; size_bytes: number }
  | { ok: false; error: string };

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB — matches bucket file_size_limit

export async function uploadBlogMediaAction(formData: FormData): Promise<UploadResult> {
  try {
    const gate = await getAdminSupabase();
    if (!gate.ok) return gate;

    const file = formData.get("file");
    const postSlug = (formData.get("post_slug") as string | null) ?? "misc";

    if (!(file instanceof File)) {
      return { ok: false, error: "No file provided" };
    }
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      return { ok: false, error: `Unsupported file type ${file.type || "(unknown)"}. Allowed: JPEG, PNG, WEBP, GIF, SVG.` };
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return { ok: false, error: `File is ${(file.size / 1024 / 1024).toFixed(1)} MB; max 10 MB.` };
    }

    // Path: <slug-or-misc>/<timestamp>-<safe-filename>. Timestamp prevents
    // repeat-upload overwrite without forcing a full content hash (Storage
    // returns a unique URL even on re-upload).
    const safeSlug = postSlug.replace(/[^a-z0-9-]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "") || "misc";
    const safeName = file.name.replace(/[^a-z0-9.-]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "");
    const path = `${safeSlug}/${Date.now()}-${safeName}`;

    const arrayBuffer = await file.arrayBuffer();
    const { error: uploadErr } = await gate.supabase.storage
      .from("blog-media")
      .upload(path, arrayBuffer, {
        contentType: file.type,
        cacheControl: "31536000",  // 1 year — files are content-hashed via timestamp prefix
        upsert: false,
      });
    if (uploadErr) return { ok: false, error: uploadErr.message };

    const { data: pub } = gate.supabase.storage.from("blog-media").getPublicUrl(path);
    return {
      ok: true,
      public_url: pub.publicUrl,
      storage_path: path,
      size_bytes: file.size,
    };
  } catch (err) {
    return { ok: false, error: `uploadBlogMediaAction threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}
