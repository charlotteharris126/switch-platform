import { PageHeader } from "@/components/page-header";
import Link from "next/link";
import { listTagsWithUsageAction } from "../actions";
import { TagsClient } from "./tags-client";

export const dynamic = "force-dynamic";

export default async function TagsAdminPage() {
  const result = await listTagsWithUsageAction();

  if (!result.ok) {
    return (
      <div className="max-w-4xl space-y-4">
        <PageHeader eyebrow="Blog" title="Tags" />
        <p className="text-[#b3412e]">Failed to load tags: {result.error}</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-8">
      <PageHeader
        eyebrow={
          <Link href="/admin/blog" className="text-[#287271] underline">
            ← Blog
          </Link>
        }
        title="Tags"
        subtitle="Universal tag registry. Create, edit, and retroactively apply tags to existing posts."
      />
      <TagsClient initialTags={result.data} />
    </div>
  );
}
