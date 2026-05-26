import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listPostsAction, type Post } from "./actions";

export const dynamic = "force-dynamic";

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const CADENCE_TARGET_DAYS = 7;

function viewUrl(post: Pick<Post, "status" | "slug">): { href: string; label: string; external: boolean } {
  if (post.status === "published") {
    return {
      href: `https://switchable.org.uk/the-switch/${post.slug}/`,
      label: "View live",
      external: true,
    };
  }
  return {
    href: `/admin/blog/${post.slug}/preview`,
    label: "Preview",
    external: false,
  };
}

export default async function BlogAdminPage() {
  const result = await listPostsAction();

  if (!result.ok) {
    return (
      <div className="max-w-6xl space-y-4">
        <PageHeader eyebrow="Tools" title="Blog" />
        <p className="text-[#b3412e]">Failed to load posts: {result.error}</p>
      </div>
    );
  }

  const posts = result.data;
  const drafts = posts.filter((p) => p.status === "draft");
  const scheduled = posts.filter((p) => p.status === "scheduled");
  const published = posts
    .filter((p) => p.status === "published")
    .sort((a, b) => (b.publish_date ?? "").localeCompare(a.publish_date ?? ""));
  const archived = posts.filter((p) => p.status === "archived");

  const lastPublished = published[0];
  const daysSinceLast = lastPublished?.publish_date
    ? daysBetween(new Date(), new Date(lastPublished.publish_date))
    : null;

  let cadenceState: "healthy" | "amber" | "red" | "unknown" = "unknown";
  if (daysSinceLast == null) cadenceState = "unknown";
  else if (daysSinceLast <= CADENCE_TARGET_DAYS) cadenceState = "healthy";
  else if (daysSinceLast <= CADENCE_TARGET_DAYS * 2) cadenceState = "amber";
  else cadenceState = "red";

  const cadenceColours = {
    healthy: "bg-[#dcefea] text-[#1f5f5e] border-[#bcdfd8]",
    amber: "bg-[#fcefd6] text-[#92651c] border-[#f0d99c]",
    red: "bg-[#f7d8d0] text-[#8a2e1a] border-[#e9b3a4]",
    unknown: "bg-[#eee9e0] text-[#5a6a72] border-[#d4ccc0]",
  } as const;

  const nextScheduled = scheduled
    .filter((p) => p.publish_date)
    .sort((a, b) => (a.publish_date ?? "").localeCompare(b.publish_date ?? ""))[0];

  return (
    <div className="max-w-6xl space-y-8">
      <PageHeader
        eyebrow="Tools"
        title="Blog"
        subtitle={
          <>
            {posts.length} post{posts.length === 1 ? "" : "s"} in the CMS. Click any row to edit; use the right-side button to preview or open live.
          </>
        }
        actions={
          <div className="flex gap-2">
            <Link href="/admin/blog/featured">
              <Button variant="outline">Featured</Button>
            </Link>
            <Link href="/admin/blog/calendar">
              <Button variant="outline">Calendar</Button>
            </Link>
            <Link href="/admin/blog/tags">
              <Button variant="outline">Tags</Button>
            </Link>
            <Link href="/admin/blog/new">
              <Button>+ New post</Button>
            </Link>
          </div>
        }
      />

      <section className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-[#e5dfd8] bg-white p-5">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a6a72] mb-2">
            Published
          </div>
          <div className="text-3xl font-extrabold text-[#11242e]">{published.length}</div>
        </div>
        <div
          className={`rounded-2xl border p-5 ${
            drafts.length > 0
              ? "bg-[#fcefd6] text-[#92651c] border-[#f0d99c]"
              : "border-[#e5dfd8] bg-white"
          }`}
        >
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] mb-2 opacity-80">
            Drafts awaiting proof
          </div>
          <div className="text-3xl font-extrabold">{drafts.length}</div>
        </div>
        <div className="rounded-2xl border border-[#e5dfd8] bg-white p-5">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a6a72] mb-2">
            Scheduled
          </div>
          <div className="text-3xl font-extrabold text-[#11242e]">{scheduled.length}</div>
        </div>
        <div className={`rounded-2xl border p-5 ${cadenceColours[cadenceState]}`}>
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] mb-2 opacity-80">
            Cadence
          </div>
          <div className="text-2xl font-extrabold">
            {daysSinceLast == null ? "—" : `${daysSinceLast}d`}
          </div>
          <div className="text-[11px] font-semibold mt-1 opacity-80">
            {daysSinceLast == null
              ? "No posts published yet"
              : `since last post · target ≤ ${CADENCE_TARGET_DAYS}d`}
          </div>
        </div>
      </section>

      {nextScheduled && (
        <section className="rounded-2xl border border-[#e5dfd8] bg-white p-5">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a6a72] mb-2">
            Next scheduled
          </div>
          <Link
            href={`/admin/blog/${nextScheduled.slug}/edit`}
            className="text-base font-bold text-[#11242e] hover:text-[#287271]"
          >
            {nextScheduled.title}
          </Link>
          <div className="text-xs text-[#5a6a72] mt-1">
            {nextScheduled.category_id ?? "Uncategorised"} · {formatDate(nextScheduled.publish_date)}
          </div>
        </section>
      )}

      {drafts.length > 0 && (
        <PostSection
          heading="Drafts"
          posts={drafts}
          columns={["category", "reading", "updated", "view"]}
        />
      )}

      {scheduled.length > 0 && (
        <PostSection
          heading="Scheduled"
          posts={scheduled}
          columns={["category", "publish_date", "reading", "view"]}
        />
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-extrabold text-[#11242e]">Published</h2>
        {published.length === 0 ? (
          <p className="text-sm text-[#5a6a72]">
            No published posts yet. Once the first post lands, cadence health will start tracking.
          </p>
        ) : (
          <PostSection
            heading={null}
            posts={published}
            columns={["category", "publish_date", "reading", "view"]}
          />
        )}
      </section>

      {archived.length > 0 && (
        <PostSection
          heading="Archived"
          posts={archived}
          columns={["publish_date", "view"]}
        />
      )}
    </div>
  );
}

type Column = "category" | "publish_date" | "reading" | "updated" | "view";

function PostSection({
  heading,
  posts,
  columns,
}: {
  heading: string | null;
  posts: Post[];
  columns: Column[];
}) {
  return (
    <section className="space-y-2">
      {heading && <h2 className="text-lg font-extrabold text-[#11242e]">{heading}</h2>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            {columns.includes("category") && <TableHead>Category</TableHead>}
            {columns.includes("publish_date") && <TableHead>Published</TableHead>}
            {columns.includes("reading") && <TableHead className="text-right">Reading</TableHead>}
            {columns.includes("updated") && <TableHead>Updated</TableHead>}
            {columns.includes("view") && <TableHead className="text-right">Action</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {posts.map((p) => {
            const v = viewUrl(p);
            return (
              <TableRow
                key={p.id}
                className="cursor-pointer hover:bg-[#f5f2eb] transition-colors"
              >
                <TableCell className="font-semibold">
                  <Link
                    href={`/admin/blog/${p.slug}/edit`}
                    className="block hover:text-[#287271]"
                  >
                    {p.featured_position && (
                      <span className="inline-block text-[9px] font-bold uppercase tracking-wider bg-[#E9C46A] text-[#11242e] px-1.5 py-0.5 rounded mr-2">
                        Featured #{p.featured_position}
                      </span>
                    )}
                    {p.title || <em className="text-[#5a6a72]">Untitled</em>}
                  </Link>
                </TableCell>
                {columns.includes("category") && (
                  <TableCell className="text-xs">
                    <Link href={`/admin/blog/${p.slug}/edit`} className="block">
                      {p.category_id ?? "—"}
                    </Link>
                  </TableCell>
                )}
                {columns.includes("publish_date") && (
                  <TableCell className="text-xs text-[#5a6a72]">
                    <Link href={`/admin/blog/${p.slug}/edit`} className="block">
                      {formatDate(p.publish_date)}
                    </Link>
                  </TableCell>
                )}
                {columns.includes("reading") && (
                  <TableCell className="text-right text-xs">
                    <Link href={`/admin/blog/${p.slug}/edit`} className="block">
                      {p.reading_time_minutes ? `${p.reading_time_minutes} min` : "—"}
                    </Link>
                  </TableCell>
                )}
                {columns.includes("updated") && (
                  <TableCell className="text-xs text-[#5a6a72]">
                    <Link href={`/admin/blog/${p.slug}/edit`} className="block">
                      {formatDate(p.updated_at)}
                    </Link>
                  </TableCell>
                )}
                {columns.includes("view") && (
                  <TableCell className="text-right">
                    {v.external ? (
                      <a
                        href={v.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block text-[#287271] font-semibold text-xs underline"
                      >
                        {v.label} ↗
                      </a>
                    ) : (
                      <Link
                        href={v.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block text-[#287271] font-semibold text-xs underline"
                      >
                        {v.label}
                      </Link>
                    )}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}
