import { PageHeader } from "@/components/page-header";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getPostBySlugAction,
  listCategoriesAction,
  listTagsAction,
} from "../../actions";
import { PostForm } from "../../post-form";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

type Params = { slug: string };

export default async function EditBlogPostPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;

  const [postResult, catsResult, tagsResult] = await Promise.all([
    getPostBySlugAction(slug),
    listCategoriesAction(),
    listTagsAction(),
  ]);

  if (!postResult.ok) {
    if (postResult.error === "Post not found") notFound();
    return (
      <div className="max-w-4xl space-y-4">
        <PageHeader eyebrow="Blog" title="Edit post" />
        <p className="text-[#b3412e]">Failed to load post: {postResult.error}</p>
      </div>
    );
  }

  if (!catsResult.ok || !tagsResult.ok) {
    return (
      <div className="max-w-4xl space-y-4">
        <PageHeader eyebrow="Blog" title="Edit post" />
        <p className="text-[#b3412e]">
          Failed to load form options:{" "}
          {!catsResult.ok ? catsResult.error : (tagsResult.ok ? "" : tagsResult.error)}
        </p>
      </div>
    );
  }

  const { post, tagSlugs } = postResult.data;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <Link href="/admin/blog" className="text-[#287271] underline">
            ← Blog
          </Link>
        }
        title={`Edit · ${post.title}`}
        subtitle={
          <span className="text-xs text-[#5a6a72]">
            <code className="font-mono">{post.slug}</code> · status {post.status}
            {post.publish_date && ` · ${post.publish_date}`}
          </span>
        }
        actions={
          <div className="flex gap-2">
            <Link href={`/admin/blog/${post.slug}/preview`} target="_blank" rel="noopener noreferrer">
              <Button variant="outline">Preview ↗</Button>
            </Link>
            {post.status === "published" && (
              <a
                href={`https://switchable.org.uk/blog/${post.slug}/`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button>View live ↗</Button>
              </a>
            )}
          </div>
        }
      />
      <PostForm
        mode="edit"
        categories={catsResult.data}
        allTags={tagsResult.data}
        initial={{ post, tagSlugs }}
      />
    </div>
  );
}
