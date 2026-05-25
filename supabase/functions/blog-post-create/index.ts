// Edge Function: blog-post-create
//
// Programmatic write surface for editorial.posts so agents (Mira, Wren,
// dedicated draft-blog-post invocations) can create blog drafts without
// going through the /admin/blog UI. Mirrors createPostAction's behaviour:
// validates input, INSERTs into editorial.posts, links tags via post_tags,
// returns the created row's id + slug + admin URL.
//
// Auth: x-audit-key (same pattern as admin-brevo-resync, blog-ai-assist).
// Agents fetch the secret via public.get_shared_secret('AUDIT_SHARED_SECRET')
// and pass it in the header. The audit-key path bypasses RLS via the
// SUPABASE_DB_URL service connection — there's no per-user gate on this
// endpoint; the audit secret IS the gate.
//
// Lands every post as status=draft regardless of input — the agent shouldn't
// auto-publish. Charlotte proofs + flips status manually (or via the auto-
// publish cron once she sets a future publish_date).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });

interface PostInput {
  slug: string;
  title: string;
  dek?: string | null;
  excerpt?: string | null;
  body: string;
  category_id?: string | null;
  publish_date?: string | null;          // 'YYYY-MM-DD' or null
  cover_image_url?: string | null;
  cover_image_alt?: string | null;
  featured?: boolean;
  lead_magnet_enabled?: boolean;
  meta_title?: string | null;
  meta_description?: string | null;
  og_title?: string | null;
  og_description?: string | null;
  og_image_url?: string | null;
  canonical_url?: string | null;
  target_keywords?: string[];
  internal_links?: string[];
  related_courses?: string[];
  end_cta?: Record<string, unknown> | null;
}

interface CreateRequest {
  post: PostInput;
  tag_slugs?: string[];                  // slugs from editorial.tags; unknown silently ignored
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);

  // Auth — mirror the admin-brevo-resync x-audit-key pattern. Agents fetch
  // the secret via psql against public.get_shared_secret() and pass it here.
  const auditKey = req.headers.get("x-audit-key");
  const expected = Deno.env.get("AUDIT_SHARED_SECRET");
  if (!auditKey || auditKey !== expected) {
    return json({ ok: false, error: "unauthorised" }, 401);
  }

  let body: CreateRequest;
  try {
    body = await req.json() as CreateRequest;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const post = body.post;
  if (!post) return json({ ok: false, error: "post is required" }, 400);

  // Validation — same rules as createPostAction so the EF and the UI accept
  // the same shape.
  if (!post.slug || !post.slug.trim()) return json({ ok: false, error: "slug is required" }, 400);
  if (!SLUG_RE.test(post.slug.trim())) {
    return json({ ok: false, error: "slug must be lowercase letters / numbers / hyphens (e.g. how-to-change-career-uk)" }, 400);
  }
  if (!post.title || !post.title.trim()) return json({ ok: false, error: "title is required" }, 400);
  if (post.title.length > 200) return json({ ok: false, error: "title is too long (200 char max)" }, 400);
  if (post.dek && post.dek.length > 300) return json({ ok: false, error: "dek is too long (300 char max)" }, 400);
  if (!post.body || !post.body.trim()) return json({ ok: false, error: "body is required" }, 400);

  // Reading-time computed server-side — 220 wpm.
  const wordCount = post.body.trim().split(/\s+/).filter(Boolean).length;
  const readingTimeMinutes = Math.max(1, Math.round(wordCount / 220));

  // Lock status to draft regardless of input. The agent's job is to write a
  // draft; publishing is Charlotte's call.
  const status = "draft";

  try {
    // Slug-uniqueness pre-check so we return a clean error instead of
    // surfacing the constraint violation.
    const existing = await sql<Array<{ id: number }>>`
      SELECT id FROM editorial.posts WHERE slug = ${post.slug.trim()} LIMIT 1
    `;
    if (existing.length > 0) {
      return json({ ok: false, error: `Slug "${post.slug}" already exists. Pick a different slug or update via /admin/blog/${post.slug}/edit.` }, 409);
    }

    const [inserted] = await sql<Array<{ id: number; slug: string }>>`
      INSERT INTO editorial.posts (
        slug, title, dek, excerpt, body,
        category_id, status, publish_date, reading_time_minutes,
        cover_image_url, cover_image_alt, featured, lead_magnet_enabled,
        meta_title, meta_description, og_title, og_description, og_image_url,
        canonical_url, target_keywords, internal_links, related_courses, end_cta
      ) VALUES (
        ${post.slug.trim()},
        ${post.title.trim()},
        ${post.dek ?? null},
        ${post.excerpt ?? null},
        ${post.body},
        ${post.category_id ?? null},
        ${status},
        ${post.publish_date ?? null},
        ${readingTimeMinutes},
        ${post.cover_image_url ?? null},
        ${post.cover_image_alt ?? null},
        ${post.featured === true},
        ${post.lead_magnet_enabled !== false},
        ${post.meta_title ?? null},
        ${post.meta_description ?? null},
        ${post.og_title ?? null},
        ${post.og_description ?? null},
        ${post.og_image_url ?? null},
        ${post.canonical_url ?? null},
        ${sql.array(post.target_keywords ?? [])},
        ${sql.array(post.internal_links ?? [])},
        ${sql.array(post.related_courses ?? [])},
        ${sql.json(post.end_cta ?? { type: "course-finder" })}
      )
      RETURNING id, slug
    `;

    // Tag linking — same shape as createPostAction's syncTags. Unknown slugs
    // are silently dropped (returned in unknown_tag_slugs for the caller).
    const tagSlugsIn = Array.isArray(body.tag_slugs) ? body.tag_slugs.map(String) : [];
    const linkedTags: number[] = [];
    const unknownTagSlugs: string[] = [];
    if (tagSlugsIn.length > 0) {
      const tagRows = await sql<Array<{ id: number; slug: string }>>`
        SELECT id, slug FROM editorial.tags WHERE slug = ANY(${sql.array(tagSlugsIn)})
      `;
      const idBySlug = new Map(tagRows.map((r) => [r.slug, r.id]));
      for (const slug of tagSlugsIn) {
        const id = idBySlug.get(slug);
        if (id != null) linkedTags.push(id);
        else unknownTagSlugs.push(slug);
      }
      if (linkedTags.length > 0) {
        const links = linkedTags.map((tagId) => ({ post_id: inserted.id, tag_id: tagId }));
        await sql`
          INSERT INTO editorial.post_tags ${sql(links, "post_id", "tag_id")}
          ON CONFLICT DO NOTHING
        `;
      }
    }

    return json({
      ok: true,
      post: {
        id: inserted.id,
        slug: inserted.slug,
        status,
        admin_url: `https://app.switchleads.co.uk/admin/blog/${inserted.slug}/edit`,
        preview_url: `https://app.switchleads.co.uk/admin/blog/${inserted.slug}/preview`,
      },
      tags: {
        linked: linkedTags.length,
        unknown: unknownTagSlugs,
      },
    }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("blog-post-create insert failed:", message);
    return json({ ok: false, error: message }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
