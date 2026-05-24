"use client";

// Shared form for /admin/blog/new and /admin/blog/[slug]/edit. The parent
// server component fetches initial data (categories, tags, optional
// existing post) and passes them in. This component owns all field state
// and dispatches the appropriate server action.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPostAction, updatePostAction, deletePostAction } from "./actions";
import type { Post, PostFormInput, PostStatus } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Category = { id: string; name: string };
type TagOption = { slug: string; name: string };

export type PostFormProps = {
  mode: "create" | "edit";
  categories: Category[];
  allTags: TagOption[];
  initial?: { post: Post; tagSlugs: string[] };
};

function emptyInput(): PostFormInput {
  return {
    slug: "",
    title: "",
    dek: "",
    excerpt: "",
    body: "",
    category_id: "",
    status: "draft",
    publish_date: "",
    cover_image_url: "",
    cover_image_alt: "",
    featured: false,
    lead_magnet_enabled: true,
    meta_title: "",
    meta_description: "",
    og_title: "",
    og_description: "",
    og_image_url: "",
    canonical_url: "",
    target_keywords: "",
    tags: "",
  };
}

function fromPost(post: Post, tagSlugs: string[]): PostFormInput {
  return {
    slug: post.slug,
    title: post.title,
    dek: post.dek ?? "",
    excerpt: post.excerpt ?? "",
    body: post.body,
    category_id: post.category_id ?? "",
    status: post.status,
    publish_date: post.publish_date ?? "",
    cover_image_url: post.cover_image_url ?? "",
    cover_image_alt: post.cover_image_alt ?? "",
    featured: post.featured,
    lead_magnet_enabled: post.lead_magnet_enabled,
    meta_title: post.meta_title ?? "",
    meta_description: post.meta_description ?? "",
    og_title: post.og_title ?? "",
    og_description: post.og_description ?? "",
    og_image_url: post.og_image_url ?? "",
    canonical_url: post.canonical_url ?? "",
    target_keywords: post.target_keywords.join(", "),
    tags: tagSlugs.join(", "),
  };
}

export function PostForm({ mode, categories, allTags, initial }: PostFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [input, setInput] = useState<PostFormInput>(
    initial ? fromPost(initial.post, initial.tagSlugs) : emptyInput(),
  );
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function update<K extends keyof PostFormInput>(key: K, value: PostFormInput[K]) {
    setInput((prev) => ({ ...prev, [key]: value }));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    startTransition(async () => {
      const result =
        mode === "create"
          ? await createPostAction(input)
          : await updatePostAction(initial!.post.slug, input);

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setSuccess(mode === "create" ? "Post created" : "Saved");
      if (mode === "create") {
        router.push(`/admin/blog/${result.data.slug}/edit`);
      } else if (result.data.slug !== initial!.post.slug) {
        // Slug changed; navigate to the new URL.
        router.push(`/admin/blog/${result.data.slug}/edit`);
      } else {
        router.refresh();
      }
    });
  }

  function onDelete() {
    if (!initial) return;
    if (!confirm(`Delete draft "${initial.post.title}"? This is permanent.`)) return;

    startTransition(async () => {
      const result = await deletePostAction(initial.post.slug);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/admin/blog");
    });
  }

  const known = new Set(allTags.map((t) => t.slug));
  const enteredTagSlugs = input.tags
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknownTags = enteredTagSlugs.filter((s) => !known.has(s));

  return (
    <form onSubmit={onSubmit} className="space-y-8 max-w-4xl">
      {error && (
        <div className="rounded-lg border border-[#e9b3a4] bg-[#f7d8d0] text-[#8a2e1a] px-4 py-3 text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-lg border border-[#bcdfd8] bg-[#dcefea] text-[#1f5f5e] px-4 py-3 text-sm">
          {success}
        </div>
      )}

      <section className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="slug">URL slug</Label>
            <Input
              id="slug"
              value={input.slug}
              onChange={(e) => update("slug", e.target.value)}
              placeholder="how-to-change-career-uk"
              required
              disabled={pending}
            />
            <p className="text-[11px] text-[#5a6a72] mt-1">
              Becomes <code className="font-mono">/blog/{input.slug || "your-slug"}/</code>. Lowercase, hyphens, no spaces.
            </p>
          </div>
          <div>
            <Label htmlFor="status">Status</Label>
            <select
              id="status"
              value={input.status}
              onChange={(e) => update("status", e.target.value as PostStatus)}
              disabled={pending}
              className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm"
            >
              <option value="draft">Draft</option>
              <option value="scheduled">Scheduled</option>
              <option value="published">Published</option>
              <option value="archived">Archived</option>
            </select>
          </div>
        </div>

        <div>
          <Label htmlFor="title">Title</Label>
          <Input
            id="title"
            value={input.title}
            onChange={(e) => update("title", e.target.value)}
            placeholder="How to change career in the UK (and actually make it stick)"
            required
            disabled={pending}
          />
        </div>

        <div>
          <Label htmlFor="dek">Dek (sub-headline, shown under the title)</Label>
          <Input
            id="dek"
            value={input.dek}
            onChange={(e) => update("dek", e.target.value)}
            placeholder="Optional. One-sentence positioning under the title."
            disabled={pending}
          />
        </div>

        <div>
          <Label htmlFor="excerpt">Excerpt (used in /blog/ listings + meta description fallback)</Label>
          <textarea
            id="excerpt"
            value={input.excerpt}
            onChange={(e) => update("excerpt", e.target.value)}
            placeholder="2-3 sentence summary that sells the click."
            rows={3}
            disabled={pending}
            className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
          />
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="font-bold text-[#11242e] text-sm uppercase tracking-wider">Body</h3>
        <textarea
          id="body"
          value={input.body}
          onChange={(e) => update("body", e.target.value)}
          placeholder="Markdown. Shortcodes supported: {{pull-quote: text}} and {{recommended-next}}."
          rows={28}
          required
          disabled={pending}
          className="w-full px-3 py-3 rounded-md border border-input bg-background font-mono text-sm"
        />
        <p className="text-[11px] text-[#5a6a72]">
          Words: {input.body.trim().split(/\s+/).filter(Boolean).length} · est. reading time{" "}
          {Math.max(1, Math.round(input.body.trim().split(/\s+/).filter(Boolean).length / 220))} min
        </p>
      </section>

      <section className="space-y-4">
        <h3 className="font-bold text-[#11242e] text-sm uppercase tracking-wider">Taxonomy</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="category_id">Category</Label>
            <select
              id="category_id"
              value={input.category_id}
              onChange={(e) => update("category_id", e.target.value)}
              disabled={pending}
              className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm"
            >
              <option value="">— None —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="tags">Tags (comma-separated slugs)</Label>
            <Input
              id="tags"
              value={input.tags}
              onChange={(e) => update("tags", e.target.value)}
              placeholder="skills-bootcamps, eligibility, mid-life-career"
              disabled={pending}
            />
            {unknownTags.length > 0 && (
              <p className="text-[11px] text-[#b3412e] mt-1">
                Unknown tag slugs (will be ignored): {unknownTags.join(", ")}. Add via /admin/blog/tags (next session) or use one of:{" "}
                {allTags.slice(0, 6).map((t) => t.slug).join(", ")}…
              </p>
            )}
          </div>
        </div>

        <div>
          <Label htmlFor="target_keywords">Target keywords (comma-separated)</Label>
          <Input
            id="target_keywords"
            value={input.target_keywords}
            onChange={(e) => update("target_keywords", e.target.value)}
            placeholder="change career uk, career change at 40"
            disabled={pending}
          />
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="font-bold text-[#11242e] text-sm uppercase tracking-wider">Publishing</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="publish_date">Publish date</Label>
            <Input
              id="publish_date"
              type="date"
              value={input.publish_date}
              onChange={(e) => update("publish_date", e.target.value)}
              disabled={pending}
            />
            <p className="text-[11px] text-[#5a6a72] mt-1">
              Required for scheduled or published. Scheduled posts auto-flip on this date.
            </p>
          </div>
          <div className="space-y-2 pt-6">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={input.featured}
                onChange={(e) => update("featured", e.target.checked)}
                disabled={pending}
              />
              Feature on /blog/ home (only one can be featured at a time)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={input.lead_magnet_enabled}
                onChange={(e) => update("lead_magnet_enabled", e.target.checked)}
                disabled={pending}
              />
              Show lead-magnet CTA in the bottom-of-post stack
            </label>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="font-bold text-[#11242e] text-sm uppercase tracking-wider">Cover image</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="cover_image_url">URL</Label>
            <Input
              id="cover_image_url"
              value={input.cover_image_url}
              onChange={(e) => update("cover_image_url", e.target.value)}
              placeholder="/brand/blog/your-slug.jpg or full URL"
              disabled={pending}
            />
            <p className="text-[11px] text-[#5a6a72] mt-1">
              Storage upload UI lands next session. For now, drop the file at <code className="font-mono">deploy/brand/blog/&lt;slug&gt;.jpg</code> and reference here.
            </p>
          </div>
          <div>
            <Label htmlFor="cover_image_alt">Alt text</Label>
            <Input
              id="cover_image_alt"
              value={input.cover_image_alt}
              onChange={(e) => update("cover_image_alt", e.target.value)}
              placeholder="Descriptive alt — needed for accessibility + SEO"
              disabled={pending}
            />
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="font-bold text-[#11242e] text-sm uppercase tracking-wider">SEO + social</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="meta_title">Meta title (Google tab)</Label>
            <Input
              id="meta_title"
              value={input.meta_title}
              onChange={(e) => update("meta_title", e.target.value)}
              placeholder="Defaults to title if blank"
              disabled={pending}
            />
          </div>
          <div>
            <Label htmlFor="canonical_url">Canonical URL</Label>
            <Input
              id="canonical_url"
              value={input.canonical_url}
              onChange={(e) => update("canonical_url", e.target.value)}
              placeholder="Defaults to /blog/<slug>/"
              disabled={pending}
            />
          </div>
        </div>
        <div>
          <Label htmlFor="meta_description">Meta description (Google snippet)</Label>
          <textarea
            id="meta_description"
            value={input.meta_description}
            onChange={(e) => update("meta_description", e.target.value)}
            placeholder="155-160 chars max. Defaults to excerpt if blank."
            rows={2}
            disabled={pending}
            className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="og_title">OG title (social share card)</Label>
            <Input
              id="og_title"
              value={input.og_title}
              onChange={(e) => update("og_title", e.target.value)}
              placeholder="Defaults to title"
              disabled={pending}
            />
          </div>
          <div>
            <Label htmlFor="og_image_url">OG image URL</Label>
            <Input
              id="og_image_url"
              value={input.og_image_url}
              onChange={(e) => update("og_image_url", e.target.value)}
              placeholder="Defaults to cover image"
              disabled={pending}
            />
          </div>
        </div>
        <div>
          <Label htmlFor="og_description">OG description (social share)</Label>
          <textarea
            id="og_description"
            value={input.og_description}
            onChange={(e) => update("og_description", e.target.value)}
            placeholder="Defaults to meta description"
            rows={2}
            disabled={pending}
            className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
          />
        </div>
      </section>

      <section className="flex items-center justify-between gap-4 pt-6 border-t border-[#e5dfd8]">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : mode === "create" ? "Create draft" : "Save"}
        </Button>
        {mode === "edit" && initial?.post.status === "draft" && (
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={onDelete}
          >
            Delete draft
          </Button>
        )}
      </section>
    </form>
  );
}
