// In-admin preview of a blog post draft.
//
// Renders the markdown body to HTML server-side with `marked`, in a layout
// that loosely matches the live /blog/<slug>/ template (title + dek +
// metadata strip + cover image + prose body). Does NOT pretend to be
// pixel-identical to the live site — its job is to let Charlotte proof
// content + structure before flipping status to published.
//
// For published posts the list page links to the live URL directly; this
// route is for drafts / scheduled / archived where there's no live URL.

import Link from "next/link";
import { notFound } from "next/navigation";
import { Marked } from "marked";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { getPostBySlugAction, listTagsAction } from "../../actions";
import { checkSeo, checkSeoSummary } from "../../seo-checks";
import type { PostFormInput } from "../../actions";

export const dynamic = "force-dynamic";

type Params = { slug: string };

// Stable marked instance with GFM tables + line-break preservation. Mirrors
// the build-side render closely enough for proof-reading; full parity ships
// when the build flip lands (next-step #3).
const marked = new Marked({
  gfm: true,
  breaks: false,
});

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default async function PreviewBlogPostPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;

  const [postResult, tagsResult] = await Promise.all([
    getPostBySlugAction(slug),
    listTagsAction(),
  ]);

  if (!postResult.ok) {
    if (postResult.error === "Post not found") notFound();
    return (
      <div className="max-w-4xl space-y-4">
        <PageHeader eyebrow="Blog" title="Preview" />
        <p className="text-[#b3412e]">Failed to load post: {postResult.error}</p>
      </div>
    );
  }

  const { post, tagSlugs } = postResult.data;
  const allTags = tagsResult.ok ? tagsResult.data : [];
  const knownTagSlugs = new Set(allTags.map((t) => t.slug));

  // Re-run the SEO checklist against the saved DB state.
  const inputForChecks: PostFormInput = {
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
  const checks = checkSeo(inputForChecks, knownTagSlugs);
  const summary = checkSeoSummary(checks);

  // Strip our shortcodes for the preview — they expand at build time.
  // `{{related-posts}}`, `{{pull-quote: ...}}`, `{{recommended-next}}` etc.
  const bodyForRender = post.body
    .replace(/\{\{related-posts\}\}/g, '<div class="border border-dashed border-[#bcc7cc] rounded-lg p-4 text-xs text-[#5a6a72] my-6">[related posts list — rendered at build time]</div>')
    .replace(/\{\{recommended-next\}\}/g, '<div class="border border-dashed border-[#bcc7cc] rounded-lg p-4 text-xs text-[#5a6a72] my-6">[recommended-next callout — rendered at build time]</div>')
    .replace(/\{\{pull-quote:\s*([^}]+)\}\}/g, '<blockquote class="border-l-4 border-[#287271] pl-4 italic text-[#11242e] my-6">$1</blockquote>');

  const bodyHtml = await marked.parse(bodyForRender);

  const isLive = post.status === "published";
  const liveUrl = `https://switchable.org.uk/blog/${post.slug}/`;

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        eyebrow={
          <Link href="/admin/blog" className="hover:text-[#287271]">
            ← Blog
          </Link>
        }
        title={`Preview · ${post.title}`}
        subtitle={
          <span className="text-xs text-[#5a6a72]">
            <code className="font-mono">{post.slug}</code> · status {post.status}
            {post.publish_date && ` · ${formatDate(post.publish_date)}`}
          </span>
        }
        actions={
          <div className="flex gap-2">
            <Link href={`/admin/blog/${post.slug}/edit`}>
              <Button variant="outline">Edit</Button>
            </Link>
            {isLive && (
              <a href={liveUrl} target="_blank" rel="noopener noreferrer">
                <Button>Open live ↗</Button>
              </a>
            )}
          </div>
        }
      />

      <div className="rounded-md border border-[#fcefd6] bg-[#fffaf0] px-4 py-3 text-xs text-[#92651c]">
        Preview only — markdown is rendered with the in-admin parser. Shortcodes show as placeholder blocks; they expand at build time on the live site. SEO checklist:{" "}
        <strong>{summary.pass} OK</strong>
        {summary.warn > 0 && <>{" · "}<strong>{summary.warn} warn</strong></>}
        {summary.fail > 0 && <>{" · "}<strong className="text-[#8a2e1a]">{summary.fail} fix</strong></>}
        .
      </div>

      <article className="bg-white border border-[#e5dfd8] rounded-2xl overflow-hidden">
        {post.cover_image_url && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={post.cover_image_url}
            alt={post.cover_image_alt ?? ""}
            className="w-full aspect-[1200/630] object-cover"
          />
        )}

        <div className="px-6 sm:px-10 py-10 max-w-3xl mx-auto">
          {post.category_id && (
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#287271] mb-3">
              {post.category_id}
            </div>
          )}

          <h1 className="text-3xl sm:text-4xl font-extrabold text-[#11242e] leading-tight">
            {post.title}
          </h1>

          {post.dek && (
            <p className="mt-3 text-lg text-[#5a6a72] leading-relaxed">{post.dek}</p>
          )}

          <div className="flex flex-wrap gap-3 items-center text-xs text-[#5a6a72] mt-6 pb-6 border-b border-[#e5dfd8]">
            {post.publish_date && <span>{formatDate(post.publish_date)}</span>}
            {post.reading_time_minutes && (
              <>
                <span>·</span>
                <span>{post.reading_time_minutes} min read</span>
              </>
            )}
            {tagSlugs.length > 0 && (
              <>
                <span>·</span>
                <span>{tagSlugs.join(", ")}</span>
              </>
            )}
          </div>

          <div
            className="mt-8 text-[#11242e] leading-relaxed text-base
              [&_p]:my-5 [&_p]:leading-[1.7]
              [&_h2]:text-2xl [&_h2]:font-extrabold [&_h2]:text-[#11242e] [&_h2]:mt-12 [&_h2]:mb-4
              [&_h3]:text-xl [&_h3]:font-bold [&_h3]:text-[#11242e] [&_h3]:mt-10 [&_h3]:mb-3
              [&_h4]:text-lg [&_h4]:font-bold [&_h4]:text-[#11242e] [&_h4]:mt-8 [&_h4]:mb-2
              [&_a]:text-[#287271] [&_a]:underline-offset-2 hover:[&_a]:underline
              [&_strong]:font-bold [&_strong]:text-[#11242e]
              [&_ul]:my-5 [&_ul]:list-disc [&_ul]:pl-6 [&_ul_li]:my-1.5
              [&_ol]:my-5 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol_li]:my-1.5
              [&_blockquote]:border-l-4 [&_blockquote]:border-[#287271] [&_blockquote]:pl-5 [&_blockquote]:italic [&_blockquote]:text-[#11242e] [&_blockquote]:my-6
              [&_code]:bg-[#f5f2eb] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[0.9em] [&_code]:font-mono
              [&_pre]:bg-[#11242e] [&_pre]:text-white [&_pre]:p-4 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre]:my-6 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-white
              [&_hr]:my-10 [&_hr]:border-[#e5dfd8]
              [&_img]:rounded-lg [&_img]:my-6"
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />

          {post.lead_magnet_enabled && (
            <div className="mt-12 border border-dashed border-[#bcc7cc] rounded-lg p-6 text-xs text-[#5a6a72] text-center">
              [lead-magnet CTA stack — rendered at build time]
            </div>
          )}
        </div>
      </article>

      <details className="rounded-2xl border border-[#e5dfd8] bg-white p-4 text-sm">
        <summary className="cursor-pointer font-semibold text-[#11242e]">
          Search + social preview
        </summary>
        <div className="mt-4 space-y-4">
          <SerpPreview slug={post.slug} title={post.meta_title || post.title} description={post.meta_description || post.excerpt || ""} />
          <OgPreview
            title={post.og_title || post.meta_title || post.title}
            description={post.og_description || post.meta_description || post.excerpt || ""}
            image={post.og_image_url || post.cover_image_url || null}
            domain="switchable.org.uk"
          />
        </div>
      </details>
    </div>
  );
}

function SerpPreview({ slug, title, description }: { slug: string; title: string; description: string }) {
  return (
    <div className="border border-[#e5dfd8] rounded-lg p-4 max-w-2xl">
      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#5a6a72] mb-2">
        Google result preview
      </div>
      <div className="text-xs text-[#1a73e8]">switchable.org.uk › blog › {slug}</div>
      <div className="text-lg text-[#1a0dab] leading-tight mt-0.5">{title.length > 60 ? title.slice(0, 60) + "…" : title}</div>
      <div className="text-sm text-[#4d5156] mt-1">
        {description.length > 160 ? description.slice(0, 160) + "…" : description || "(Google will write its own snippet — no excerpt or meta description set.)"}
      </div>
    </div>
  );
}

function OgPreview({
  title,
  description,
  image,
  domain,
}: {
  title: string;
  description: string;
  image: string | null;
  domain: string;
}) {
  return (
    <div className="border border-[#e5dfd8] rounded-lg overflow-hidden max-w-md">
      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#5a6a72] p-3 border-b border-[#e5dfd8]">
        Facebook / LinkedIn share preview
      </div>
      {image ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={image} alt="" className="w-full aspect-[1200/630] object-cover bg-[#eee9e0]" />
      ) : (
        <div className="w-full aspect-[1200/630] bg-[#eee9e0] flex items-center justify-center text-xs text-[#5a6a72]">
          No image — share card will fall back to site default
        </div>
      )}
      <div className="p-3 bg-[#f5f2eb]">
        <div className="text-[10px] uppercase text-[#5a6a72]">{domain}</div>
        <div className="text-sm font-semibold text-[#11242e] mt-1">{title || "(no title)"}</div>
        <div className="text-xs text-[#5a6a72] mt-1 line-clamp-2">{description || "(no description)"}</div>
      </div>
    </div>
  );
}
