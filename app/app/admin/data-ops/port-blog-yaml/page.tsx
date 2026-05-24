import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { PortBlogYamlPanel } from "./port-panel";

export const dynamic = "force-dynamic";

export default function PortBlogYamlPage() {
  return (
    <div className="max-w-4xl space-y-6 py-6">
      <PageHeader
        eyebrow={<Link href="/admin/blog" className="hover:text-[#287271]">← Blog</Link>}
        title="Port launch drafts into CMS"
        subtitle="One-shot. Loads the 4 launch-set YAMLs (career-change, pensions, starting-a-business, what-funded-training-means) into editorial.posts so they're editable in the CMS. Idempotent — safe to click twice."
      />

      <div className="bg-white border border-[#e5dfd8] rounded-2xl p-5 space-y-4">
        <div>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.14em] text-[#5a6a72] mb-1">
            What this does
          </h2>
          <ul className="text-sm text-[#11242e] space-y-1 list-disc list-inside">
            <li>Reads <code className="font-mono text-xs">data/blog-launch-set.json</code> (4 drafts, pre-bundled).</li>
            <li>For each: skips if the slug already exists, otherwise inserts into <code className="font-mono text-xs">editorial.posts</code>.</li>
            <li>Links each post to its tags via <code className="font-mono text-xs">editorial.post_tags</code> (unknown tags are reported and skipped).</li>
            <li>All 4 land as <strong>draft</strong> — nothing publishes automatically.</li>
          </ul>
        </div>

        <PortBlogYamlPanel />
      </div>
    </div>
  );
}
