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
import { listPostsAction } from "./actions";

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
            {posts.length} post{posts.length === 1 ? "" : "s"} in the CMS. Live at{" "}
            <code className="font-mono text-xs">/blog/&lt;slug&gt;/</code> on the next build after publish.
          </>
        }
        actions={
          <Link href="/admin/blog/new">
            <Button>+ New post</Button>
          </Link>
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
        <section className="space-y-2">
          <h2 className="text-lg font-extrabold text-[#11242e]">Drafts</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Reading</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {drafts.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-semibold">
                    <Link
                      href={`/admin/blog/${p.slug}/edit`}
                      className="hover:text-[#287271]"
                    >
                      {p.title || <em className="text-[#5a6a72]">Untitled</em>}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs">{p.category_id ?? "—"}</TableCell>
                  <TableCell className="text-right text-xs">
                    {p.reading_time_minutes ? `${p.reading_time_minutes} min` : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-[#5a6a72]">
                    {formatDate(p.updated_at)}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/admin/blog/${p.slug}/edit`}
                      className="text-[#287271] font-semibold text-xs underline"
                    >
                      Edit
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      {scheduled.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-extrabold text-[#11242e]">Scheduled</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Publish date</TableHead>
                <TableHead className="text-right">Reading</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scheduled.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-semibold">
                    <Link
                      href={`/admin/blog/${p.slug}/edit`}
                      className="hover:text-[#287271]"
                    >
                      {p.title}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs">{p.category_id ?? "—"}</TableCell>
                  <TableCell className="text-xs text-[#5a6a72]">
                    {formatDate(p.publish_date)}
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {p.reading_time_minutes ? `${p.reading_time_minutes} min` : "—"}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/admin/blog/${p.slug}/edit`}
                      className="text-[#287271] font-semibold text-xs underline"
                    >
                      Edit
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-extrabold text-[#11242e]">Published</h2>
        {published.length === 0 ? (
          <p className="text-sm text-[#5a6a72]">
            No published posts yet. Once the first post lands, cadence health will start tracking.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Published</TableHead>
                <TableHead className="text-right">Reading</TableHead>
                <TableHead>Live</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {published.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-semibold">
                    {p.featured && (
                      <span className="inline-block text-[9px] font-bold uppercase tracking-wider bg-[#E9C46A] text-[#11242e] px-1.5 py-0.5 rounded mr-2">
                        Featured
                      </span>
                    )}
                    {p.title}
                  </TableCell>
                  <TableCell className="text-xs">{p.category_id ?? "—"}</TableCell>
                  <TableCell className="text-xs text-[#5a6a72]">
                    {formatDate(p.publish_date)}
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {p.reading_time_minutes ? `${p.reading_time_minutes} min` : "—"}
                  </TableCell>
                  <TableCell>
                    <a
                      href={`https://switchable.org.uk/blog/${p.slug}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#287271] font-semibold text-xs underline"
                    >
                      Open
                    </a>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/admin/blog/${p.slug}/edit`}
                      className="text-[#287271] font-semibold text-xs underline"
                    >
                      Edit
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      {archived.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-extrabold text-[#11242e]">Archived</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Was published</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {archived.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-semibold">{p.title}</TableCell>
                  <TableCell className="text-xs text-[#5a6a72]">
                    {formatDate(p.publish_date)}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/admin/blog/${p.slug}/edit`}
                      className="text-[#287271] font-semibold text-xs underline"
                    >
                      Edit
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </div>
  );
}
