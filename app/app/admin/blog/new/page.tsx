import { PageHeader } from "@/components/page-header";
import Link from "next/link";
import { listCategoriesAction, listTagsAction } from "../actions";
import { PostForm } from "../post-form";

export const dynamic = "force-dynamic";

export default async function NewBlogPostPage() {
  const [catsResult, tagsResult] = await Promise.all([
    listCategoriesAction(),
    listTagsAction(),
  ]);

  if (!catsResult.ok || !tagsResult.ok) {
    return (
      <div className="max-w-4xl space-y-4">
        <PageHeader eyebrow="Blog" title="New post" />
        <p className="text-[#b3412e]">
          Failed to load form options:{" "}
          {!catsResult.ok ? catsResult.error : (tagsResult.ok ? "" : tagsResult.error)}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <Link href="/admin/blog" className="text-[#287271] underline">
            ← Blog
          </Link>
        }
        title="New post"
        subtitle="Lands as draft. Flip status to scheduled or published when ready."
      />
      <PostForm
        mode="create"
        categories={catsResult.data}
        allTags={tagsResult.data}
      />
    </div>
  );
}
