"use client";

// Shared form for /admin/blog/new and /admin/blog/[slug]/edit.
//
// Layout: 2-column on desktop. Left = tabbed form (Content / SEO + Social).
// Right = sticky live SEO checklist rail. Sticky footer with Save / Preview /
// Delete so long-body edits never lose the action bar.

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createPostAction, updatePostAction, deletePostAction } from "./actions";
import type { Post, PostFormInput, PostStatus } from "./actions";
import { checkSeo } from "./seo-checks";
import { EditorSidebar } from "./editor-sidebar";
import { AiSuggestButton } from "./ai-suggest-button";
import { CoverUpload } from "./cover-upload";
import { TagInput } from "./tag-input";
import { RichEditor } from "./rich-editor";
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
  // Pre-fill publish_date when arriving from "+ Schedule" on the calendar.
  // Only honoured in create mode; edit mode reads from the post itself.
  initialPublishDate?: string;
};

type TabId = "content" | "seo";

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
    publish_time: "",
    cover_image_url: "",
    cover_image_alt: "",
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
  // Split publish_at (ISO TIMESTAMPTZ) into the YYYY-MM-DD + HH:MM the
  // form inputs want. UK timezone — Europe/London — so summer/winter
  // shifts surface as the user expects (BST = UTC+1, GMT = UTC+0).
  let pubTime = "";
  if (post.publish_at) {
    try {
      const d = new Date(post.publish_at);
      // Format in UK timezone
      const fmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/London",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      pubTime = fmt.format(d);
    } catch { /* fall through */ }
  }
  return {
    slug: post.slug,
    title: post.title,
    dek: post.dek ?? "",
    excerpt: post.excerpt ?? "",
    body: post.body,
    category_id: post.category_id ?? "",
    status: post.status,
    publish_date: post.publish_date ?? "",
    publish_time: pubTime,
    cover_image_url: post.cover_image_url ?? "",
    cover_image_alt: post.cover_image_alt ?? "",
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

// Title → slug. UK spelling, drop punctuation, lowercase, hyphenate.
function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining diacritics (U+0300 to U+036F). The literal-character
    // form of this range got mangled by past copy/paste, leaving the regex
    // matching nothing. Explicit unicode escapes survive every editor.
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")        // drop non-alphanumerics except spaces + hyphens
    .replace(/\s+/g, "-")                // spaces -> hyphens
    .replace(/-+/g, "-")                 // collapse runs
    .replace(/^-|-$/g, "")               // trim leading / trailing
    .slice(0, 75);                       // SEO-friendly length cap
}

function isoToday(): string {
  // Local-time YYYY-MM-DD without UTC drift.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function PostForm({ mode, categories, allTags, initial, initialPublishDate }: PostFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [tab, setTab] = useState<TabId>("content");
  const [input, setInput] = useState<PostFormInput>(() => {
    if (initial) return fromPost(initial.post, initial.tagSlugs);
    const base = emptyInput();
    if (initialPublishDate) {
      base.publish_date = initialPublishDate;
      base.status = "scheduled";
    }
    return base;
  });
  // Track whether the user has manually edited the slug. Once true, the
  // title→slug auto-fill stops overwriting their work. Edit mode starts
  // with this true (slug came from the existing post).
  const [slugManuallyEdited, setSlugManuallyEdited] = useState<boolean>(mode === "edit");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function update<K extends keyof PostFormInput>(key: K, value: PostFormInput[K]) {
    setInput((prev) => {
      const next = { ...prev, [key]: value };
      // Title → slug auto-fill, only while the slug is untouched in create mode.
      if (key === "title" && !slugManuallyEdited && mode === "create") {
        next.slug = slugFromTitle(String(value));
      }
      return next;
    });
  }

  function handleSlugChange(value: string) {
    setSlugManuallyEdited(true);
    setInput((prev) => ({ ...prev, slug: value }));
  }

  const knownTagSlugs = useMemo(() => new Set(allTags.map((t) => t.slug)), [allTags]);
  const checks = useMemo(() => checkSeo(input, knownTagSlugs), [input, knownTagSlugs]);

  async function persist(): Promise<{ ok: true; slug: string } | { ok: false; error: string }> {
    const result =
      mode === "create"
        ? await createPostAction(input)
        : await updatePostAction(initial!.post.slug, input);
    if (!result.ok) return result;
    return { ok: true, slug: result.data.slug };
  }

  function handleSave(then?: "stay" | "preview") {
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const result = await persist();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSuccess(mode === "create" ? "Post created" : "Saved");

      if (then === "preview") {
        // Use the persisted slug — it may have changed from initial.
        window.open(`/admin/blog/${result.slug}/preview`, "_blank", "noopener");
      }

      if (mode === "create") {
        router.push(`/admin/blog/${result.slug}/edit`);
      } else if (result.slug !== initial!.post.slug) {
        router.push(`/admin/blog/${result.slug}/edit`);
      } else {
        router.refresh();
      }
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    handleSave("stay");
  }

  function onSaveAndPreview() {
    handleSave("preview");
  }

  function onPreviewOnly() {
    if (!initial) {
      setError("Save the draft first to preview it.");
      return;
    }
    window.open(`/admin/blog/${initial.post.slug}/preview`, "_blank", "noopener");
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

  const wordCount = input.body.trim().split(/\s+/).filter(Boolean).length;
  const readingTime = Math.max(1, Math.round(wordCount / 220));

  return (
    <form onSubmit={onSubmit} className="space-y-6 pb-28 [&_[data-slot=input]]:bg-white">
{/*
  [&_[data-slot=input]]:bg-white forces every Input in the editor to white
  background. Shared Input primitive defaults to bg-transparent, which
  inherits the cream admin theme — Charlotte flagged that as hard-to-see.
  Scoped to this form so other admin pages keep their themed inputs.
*/}
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

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 items-start">
        <div className="space-y-6 min-w-0">
          <TabBar tab={tab} setTab={setTab} />

          {tab === "content" && (
            <ContentTab
              input={input}
              update={update}
              onSlugChange={handleSlugChange}
              slugAutoFilled={!slugManuallyEdited && mode === "create" && input.slug.length > 0}
              pending={pending}
              categories={categories}
              allTags={allTags}
              wordCount={wordCount}
              readingTime={readingTime}
              postId={initial?.post.id ?? null}
              postSlug={initial?.post.slug ?? null}
            />
          )}

          {tab === "seo" && (
            <SeoTab
              input={input}
              update={update}
              pending={pending}
              postId={initial?.post.id ?? null}
              postSlug={initial?.post.slug ?? null}
            />
          )}
        </div>

        <EditorSidebar
          checks={checks}
          title={input.title}
          dek={input.dek}
          body={input.body}
        />
      </div>

      <StickyFooter
        mode={mode}
        pending={pending}
        canDelete={mode === "edit" && initial?.post.status === "draft"}
        onSave={() => handleSave("stay")}
        onSaveAndPreview={onSaveAndPreview}
        onPreview={onPreviewOnly}
        onDelete={onDelete}
        previewDisabled={!initial}
      />
    </form>
  );
}

function TabBar({ tab, setTab }: { tab: TabId; setTab: (t: TabId) => void }) {
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "content", label: "Content" },
    { id: "seo", label: "SEO + social" },
  ];
  return (
    <div className="border-b border-[#e5dfd8]">
      <nav className="-mb-px flex gap-6">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`pb-3 text-sm font-bold border-b-2 transition-colors ${
              tab === t.id
                ? "border-[#287271] text-[#11242e]"
                : "border-transparent text-[#5a6a72] hover:text-[#11242e]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function ContentTab({
  input,
  update,
  onSlugChange,
  slugAutoFilled,
  pending,
  categories,
  allTags,
  wordCount,
  readingTime,
  postId,
  postSlug,
}: {
  input: PostFormInput;
  update: <K extends keyof PostFormInput>(key: K, value: PostFormInput[K]) => void;
  onSlugChange: (value: string) => void;
  slugAutoFilled: boolean;
  pending: boolean;
  categories: Category[];
  allTags: TagOption[];
  wordCount: number;
  readingTime: number;
  postId: number | null;
  postSlug: string | null;
}) {
  return (
    <div className="space-y-8">
      {/* Status banner — full-width row at the top of the form. Coloured pill
          shows the current state at a glance; the selector right next to it
          changes it. Sits above every other field so it's never missed. */}
      <section className="flex flex-wrap items-center gap-3 bg-white rounded-xl border border-[#e5dfd8] p-4">
        <span
          className={
            "inline-block px-3 py-1 rounded-full text-[11px] font-extrabold uppercase tracking-[0.12em] border " +
            (input.status === "published"
              ? "bg-[#dcefea] text-[#1f5f5e] border-[#bcdfd8]"
              : input.status === "scheduled"
              ? "bg-[#fbe5cb] text-[#92651c] border-[#e9c46a]"
              : input.status === "archived"
              ? "bg-[#eee9e0] text-[#5a6a72] border-[#d4ccc0]"
              : "bg-[#f5f2eb] text-[#11242e] border-[#d4ccc0]")
          }
        >
          {input.status}
        </span>
        <div className="flex items-center gap-2">
          <Label htmlFor="status" className="text-[12px] text-[#5a6a72] m-0">Change to:</Label>
          <select
            id="status"
            value={input.status}
            onChange={(e) => update("status", e.target.value as PostStatus)}
            disabled={pending}
            className="h-9 px-3 rounded-md border border-input bg-white text-sm font-bold"
          >
            <option value="draft">Draft</option>
            <option value="scheduled">Scheduled</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
        </div>
        <p className="text-[11px] text-[#5a6a72] basis-full">
          {input.status === "draft" && "Not on the live site. Visible only in admin + at /preview/the-switch/<slug>/."}
          {input.status === "scheduled" && "Will auto-flip to published when the publish date+time hits. Cron runs every 15 min."}
          {input.status === "published" && "Live on switchable.org.uk/the-switch/<slug>/. Any save fires a Netlify rebuild."}
          {input.status === "archived" && "Removed from the live site. Still in the DB for restore. Old URL 301s preserved via slug history."}
        </p>
      </section>

      <section className="space-y-4">
        <div>
          <Label htmlFor="slug">URL slug</Label>
          <Input
            id="slug"
            value={input.slug}
            onChange={(e) => onSlugChange(e.target.value)}
            placeholder="how-to-change-career-uk"
            required
            disabled={pending}
          />
          <p className="text-[11px] text-[#5a6a72] mt-1">
            {slugAutoFilled
              ? <>Auto-generated from the title. Edit to lock it.</>
              : <>Becomes <code className="font-mono">/the-switch/{input.slug || "your-slug"}/</code>. Lowercase, hyphens, no spaces.</>
            }
          </p>
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
          <CharMeter value={input.title} ideal={[40, 60]} max={70} hint="Google truncates past ~60 chars in search results." />
          <AiSuggestButton
            kind="headlines"
            label="Suggest 5 titles"
            input={input}
            postId={postId}
            postSlug={postSlug}
            currentValue={input.title}
            onApply={(v) => update("title", v)}
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
          <Label htmlFor="excerpt">Excerpt (used in The Switch listings + meta description fallback)</Label>
          <textarea
            id="excerpt"
            value={input.excerpt}
            onChange={(e) => update("excerpt", e.target.value)}
            placeholder="2-3 sentence summary that sells the click."
            rows={3}
            disabled={pending}
            className="w-full px-3 py-2 rounded-md border border-input bg-white text-sm"
          />
          <CharMeter value={input.excerpt} ideal={[140, 200]} max={300} hint="Doubles as the meta-description fallback when that field is blank." />
          <AiSuggestButton
            kind="excerpt"
            label={input.excerpt ? "Improve excerpt" : "Suggest excerpt"}
            input={input}
            postId={postId}
            postSlug={postSlug}
            currentValue={input.excerpt}
            onApply={(v) => update("excerpt", v)}
          />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="font-bold text-[#11242e] text-sm uppercase tracking-wider">Body</h3>
          <span className="text-[11px] text-[#5a6a72]">
            {wordCount} words · ~{readingTime} min read
          </span>
        </div>
        <RichEditor
          value={input.body}
          onChange={(md) => update("body", md)}
          disabled={pending}
          postSlug={postSlug}
        />
        <p className="text-[11px] text-[#5a6a72]">
          Toolbar buttons map to markdown — body is stored + rendered as markdown so the live blog template + AI suggest both work.
          H1 is reserved for the post title (rendered at the top of the live page); use H2 for sections, H3 for sub-sections.
          Image button uploads to the blog-media bucket and inserts the URL inline.
        </p>
        <AiSuggestButton
          kind="outline"
          label="Suggest H2 outline"
          input={input}
          postId={postId}
          postSlug={postSlug}
          currentValue={input.body}
          onApply={(v) => {
            // If the body is empty, drop the outline in as scaffolding.
            // If it already has content, append the outline at the bottom so
            // Charlotte can re-arrange rather than losing her work.
            if (!input.body.trim()) update("body", v);
            else update("body", `${input.body.trim()}\n\n${v}`);
          }}
        />
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
              className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm"
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
            <Label htmlFor="tags">Tags</Label>
            <TagInput
              value={input.tags}
              onChange={(v) => update("tags", v)}
              allTags={allTags}
              disabled={pending}
            />
            <p className="text-[11px] text-[#5a6a72] mt-1">
              Type to search · ↑↓ to navigate · Enter to add · Backspace on empty to remove last · manage tags at <Link href="/admin/blog/tags" className="underline">/admin/blog/tags</Link>.
            </p>
            <AiSuggestButton
              kind="tags"
              label="Suggest tags"
              input={input}
              knownTags={allTags}
              postId={postId}
              postSlug={postSlug}
              currentValue={input.tags}
              onApply={(v) => update("tags", v)}
            />
          </div>
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
              Required for scheduled / published.
            </p>
          </div>
          <div>
            <Label htmlFor="publish_time">Publish time (UK)</Label>
            <Input
              id="publish_time"
              type="time"
              value={input.publish_time}
              onChange={(e) => update("publish_time", e.target.value)}
              disabled={pending}
            />
            <p className="text-[11px] text-[#5a6a72] mt-1">
              Optional. Default 07:00 UK. Cron runs every 15 min, so the post lands within ~15 min of the chosen time.
            </p>
          </div>
          <div className="space-y-2 pt-6">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={input.lead_magnet_enabled}
                onChange={(e) => update("lead_magnet_enabled", e.target.checked)}
                disabled={pending}
              />
              Show lead-magnet CTA in the bottom-of-post stack
            </label>
            <p className="text-[11px] text-[#5a6a72]">
              To feature this post on The Switch home, visit <a href="/admin/blog/featured" className="underline text-[#287271]">/admin/blog/featured</a>. Up to 3 ranked slots, managed centrally.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function SeoTab({
  input,
  update,
  pending,
  postId,
  postSlug,
}: {
  input: PostFormInput;
  update: <K extends keyof PostFormInput>(key: K, value: PostFormInput[K]) => void;
  pending: boolean;
  postId: number | null;
  postSlug: string | null;
}) {
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h3 className="font-bold text-[#11242e] text-sm uppercase tracking-wider">Search engine</h3>
        <p className="text-[12px] text-[#5a6a72]">
          Leave blank to use the default. The checklist on the right shows the effective value that will render.
        </p>

        <div>
          <Label htmlFor="meta_title">Meta title (Google tab)</Label>
          <Input
            id="meta_title"
            value={input.meta_title}
            onChange={(e) => update("meta_title", e.target.value)}
            placeholder="Defaults to the post title"
            disabled={pending}
          />
          <CharMeter value={input.meta_title} ideal={[40, 60]} max={70} hint="Defaults to title if blank. Truncated past ~60 chars in Google." />
        </div>

        <div>
          <Label htmlFor="meta_description">Meta description (Google snippet)</Label>
          <textarea
            id="meta_description"
            value={input.meta_description}
            onChange={(e) => update("meta_description", e.target.value)}
            placeholder="Defaults to the excerpt. 140-160 chars is the sweet spot."
            rows={2}
            disabled={pending}
            className="w-full px-3 py-2 rounded-md border border-input bg-white text-sm"
          />
          <CharMeter value={input.meta_description} ideal={[140, 160]} max={170} hint="Defaults to excerpt if blank. Google truncates past ~160 chars." />
          <AiSuggestButton
            kind="meta_description"
            label={input.meta_description ? "Improve meta description" : "Suggest meta description"}
            input={input}
            postId={postId}
            postSlug={postSlug}
            currentValue={input.meta_description}
            onApply={(v) => update("meta_description", v)}
          />
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
          <p className="text-[11px] text-[#5a6a72] mt-1">
            Stored for rank-tracking + audit later. Aim for 1-3 primaries; more dilutes intent.
          </p>
        </div>

        <div>
          <Label htmlFor="canonical_url">Canonical URL (override)</Label>
          <Input
            id="canonical_url"
            value={input.canonical_url}
            onChange={(e) => update("canonical_url", e.target.value)}
            placeholder={input.slug ? `Defaults to /blog/${input.slug}/` : "Defaults to /blog/<slug>/"}
            disabled={pending}
          />
          <p className="text-[11px] text-[#5a6a72] mt-1">
            Only set this if this post is a republish of content that lives elsewhere. Leave blank otherwise.
          </p>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="font-bold text-[#11242e] text-sm uppercase tracking-wider">Cover image (also used for OG)</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="cover_image_url">URL or upload</Label>
            <CoverUpload
              value={input.cover_image_url}
              onChange={(v) => update("cover_image_url", v)}
              disabled={pending}
              postSlug={postSlug}
              placeholder="Paste a URL or click Upload"
            />
            <p className="text-[11px] text-[#5a6a72] mt-1">
              1200×630 minimum for clean OG share cards. Uploads land in the public blog-media bucket; max 10 MB, JPEG/PNG/WEBP/GIF/SVG.
            </p>
          </div>
          <div>
            <Label htmlFor="cover_image_alt">Alt text</Label>
            <Input
              id="cover_image_alt"
              value={input.cover_image_alt}
              onChange={(e) => update("cover_image_alt", e.target.value)}
              placeholder="Descriptive alt — required for accessibility + image SEO"
              disabled={pending}
            />
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="font-bold text-[#11242e] text-sm uppercase tracking-wider">Social share overrides</h3>
        <p className="text-[12px] text-[#5a6a72]">
          Optional. By default the OG card uses the meta title, meta description, and cover image. Set here only when the social cut needs to differ.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="og_title">OG title</Label>
            <Input
              id="og_title"
              value={input.og_title}
              onChange={(e) => update("og_title", e.target.value)}
              placeholder="Defaults to meta title"
              disabled={pending}
            />
            <CharMeter value={input.og_title} ideal={[40, 60]} max={88} hint="Facebook truncates past ~88 chars on cards." />
          </div>
          <div>
            <Label htmlFor="og_image_url">OG image URL</Label>
            <Input
              id="og_image_url"
              value={input.og_image_url}
              onChange={(e) => update("og_image_url", e.target.value)}
              placeholder="Defaults to the cover image"
              disabled={pending}
            />
            <p className="text-[11px] text-[#5a6a72] mt-1">
              1200×630 ideal for Facebook / LinkedIn / Twitter.
            </p>
          </div>
        </div>
        <div>
          <Label htmlFor="og_description">OG description</Label>
          <textarea
            id="og_description"
            value={input.og_description}
            onChange={(e) => update("og_description", e.target.value)}
            placeholder="Defaults to meta description"
            rows={2}
            disabled={pending}
            className="w-full px-3 py-2 rounded-md border border-input bg-white text-sm"
          />
          <CharMeter value={input.og_description} ideal={[100, 200]} max={300} hint="Facebook trims past ~200 chars in some surfaces." />
        </div>
      </section>
    </div>
  );
}

function CharMeter({
  value,
  ideal,
  max,
  hint,
}: {
  value: string;
  ideal: [number, number];
  max: number;
  hint: string;
}) {
  const len = value.length;
  let tone: "ok" | "warn" | "fail" = "ok";
  if (len === 0) tone = "ok";
  else if (len < ideal[0] || len > ideal[1]) tone = "warn";
  if (len > max) tone = "fail";
  const palette = {
    ok: "text-[#5a6a72]",
    warn: "text-[#92651c]",
    fail: "text-[#8a2e1a]",
  } as const;
  return (
    <p className={`text-[11px] mt-1 ${palette[tone]}`}>
      {len} chars · ideal {ideal[0]}-{ideal[1]} · {hint}
    </p>
  );
}

function StickyFooter({
  mode,
  pending,
  canDelete,
  previewDisabled,
  onSave,
  onSaveAndPreview,
  onPreview,
  onDelete,
}: {
  mode: "create" | "edit";
  pending: boolean;
  canDelete: boolean;
  previewDisabled: boolean;
  onSave: () => void;
  onSaveAndPreview: () => void;
  onPreview: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-30 border-t border-[#e5dfd8] bg-white/95 backdrop-blur-sm shadow-[0_-4px_12px_rgba(17,36,46,0.04)]">
      <div className="max-w-[1400px] mx-auto px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={pending} onClick={onSave}>
            {pending ? "Saving…" : mode === "create" ? "Create draft" : "Save"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={onSaveAndPreview}
          >
            Save &amp; preview
          </Button>
          {mode === "edit" && (
            <Button
              type="button"
              variant="ghost"
              disabled={pending || previewDisabled}
              onClick={onPreview}
              title={previewDisabled ? "Save the draft first" : "Open current saved version in a new tab"}
            >
              Preview (saved)
            </Button>
          )}
        </div>
        {canDelete && (
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={onDelete}
          >
            Delete draft
          </Button>
        )}
      </div>
    </div>
  );
}
