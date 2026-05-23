import { PageHeader } from "@/components/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

// Source of truth for the blog editorial state is the switchable site's
// build-time manifest at /data/posts.json (written by scripts/build-blog-posts.js).
// Read-only from this side — Charlotte authors via YAML in the site repo, the
// build emits the manifest, this page reads it. No DB schema for v1; if the
// editorial workflow grows (assignee, status beyond draft/scheduled/published,
// per-post analytics joins) we add a crm.editorial_posts table then.
const MANIFEST_URL = "https://switchable.org.uk/data/posts.json";

interface ManifestPost {
  slug: string;
  title: string;
  status: "draft" | "scheduled" | "published";
  category: string;
  category_name: string;
  publish_date: string;
  last_modified: string;
  reading_time_minutes: number;
  url: string | null;
  preview_url: string | null;
  target_keywords: string[];
}

interface Manifest {
  schema_version: string;
  generated_at: string;
  posts: ManifestPost[];
}

async function fetchManifest(): Promise<{ manifest: Manifest | null; error: string | null }> {
  try {
    const res = await fetch(MANIFEST_URL, { next: { revalidate: 60 } });
    if (!res.ok) return { manifest: null, error: `Manifest fetch returned ${res.status}` };
    const data = (await res.json()) as Manifest;
    return { manifest: data, error: null };
  } catch (e) {
    return { manifest: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const CADENCE_TARGET_DAYS = 7; // 1 post / week per Charlotte's roadmap

export default async function BlogAdminPage() {
  const { manifest, error } = await fetchManifest();
  const posts = manifest?.posts ?? [];

  // Bucket by status. Within each bucket, newest publish_date first.
  const sorted = [...posts].sort((a, b) =>
    (b.publish_date || "").localeCompare(a.publish_date || ""),
  );
  const published = sorted.filter((p) => p.status === "published");
  const drafts = sorted.filter((p) => p.status === "draft");
  const scheduled = sorted.filter((p) => p.status === "scheduled");

  // Cadence health: days since the most recent published post. If we've gone
  // past the weekly target, surface it as an amber flag. Drafts and scheduled
  // posts don't help — what matters is what's actually live.
  const now = new Date();
  const lastPublished = published[0];
  const daysSinceLast = lastPublished
    ? daysBetween(now, new Date(lastPublished.publish_date))
    : null;

  // Next scheduled post (if any): the chronologically nearest scheduled date.
  const nextScheduled = scheduled
    .filter((p) => p.publish_date)
    .sort((a, b) => a.publish_date.localeCompare(b.publish_date))[0];

  let cadenceState: "healthy" | "amber" | "red" | "unknown" = "unknown";
  if (daysSinceLast == null) cadenceState = "unknown";
  else if (daysSinceLast <= CADENCE_TARGET_DAYS) cadenceState = "healthy";
  else if (daysSinceLast <= CADENCE_TARGET_DAYS * 2) cadenceState = "amber";
  else cadenceState = "red";

  const cadenceColours: Record<typeof cadenceState, string> = {
    healthy: "bg-[#dcefea] text-[#1f5f5e] border-[#bcdfd8]",
    amber: "bg-[#fcefd6] text-[#92651c] border-[#f0d99c]",
    red: "bg-[#f7d8d0] text-[#8a2e1a] border-[#e9b3a4]",
    unknown: "bg-[#eee9e0] text-[#5a6a72] border-[#d4ccc0]",
  };

  return (
    <div className="max-w-6xl space-y-8">
      <PageHeader
        eyebrow="Tools"
        title="Blog"
        subtitle={
          error ? (
            <span className="text-[#b3412e]">
              Manifest fetch failed: {error}. Site may not have deployed posts yet.
            </span>
          ) : (
            <>
              {posts.length} post{posts.length === 1 ? "" : "s"} tracked.{" "}
              Authored as YAML in <code className="font-mono text-xs">switchable/site/deploy/data/posts/</code>.{" "}
              Build emits to{" "}
              <code className="font-mono text-xs">/blog/&lt;slug&gt;/</code>.
            </>
          )
        }
      />

      <section className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-[#e5dfd8] bg-white p-5">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a6a72] mb-2">
            Published
          </div>
          <div className="text-3xl font-extrabold text-[#11242e]">{published.length}</div>
        </div>
        <div className="rounded-2xl border border-[#e5dfd8] bg-white p-5">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a6a72] mb-2">
            Drafts
          </div>
          <div className="text-3xl font-extrabold text-[#11242e]">{drafts.length}</div>
        </div>
        <div className="rounded-2xl border border-[#e5dfd8] bg-white p-5">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a6a72] mb-2">
            Scheduled
          </div>
          <div className="text-3xl font-extrabold text-[#11242e]">{scheduled.length}</div>
        </div>
        <div
          className={`rounded-2xl border p-5 ${cadenceColours[cadenceState]}`}
        >
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] mb-2">
            Cadence
          </div>
          <div className="text-2xl font-extrabold">
            {daysSinceLast == null
              ? "—"
              : `${daysSinceLast}d`}
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
          <div className="text-base font-bold text-[#11242e]">{nextScheduled.title}</div>
          <div className="text-xs text-[#5a6a72] mt-1">
            {nextScheduled.category_name} · {formatDate(nextScheduled.publish_date)}
          </div>
        </section>
      )}

      {drafts.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-extrabold text-[#11242e]">Drafts</h2>
          <p className="text-xs text-[#5a6a72]">
            Render to <code className="font-mono">/preview/blog/&lt;slug&gt;/</code> on every build. Not indexed. Flip status to <code className="font-mono">published</code> in the YAML to ship.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Reading time</TableHead>
                <TableHead>Last modified</TableHead>
                <TableHead>Preview</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {drafts.map((p) => (
                <TableRow key={p.slug}>
                  <TableCell className="font-semibold">{p.title}</TableCell>
                  <TableCell className="text-xs">{p.category_name}</TableCell>
                  <TableCell className="text-right text-xs">
                    {p.reading_time_minutes} min
                  </TableCell>
                  <TableCell className="text-xs text-[#5a6a72]">
                    {formatDate(p.last_modified)}
                  </TableCell>
                  <TableCell>
                    {p.preview_url ? (
                      <a
                        href={p.preview_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#287271] font-semibold text-xs underline"
                      >
                        Open
                      </a>
                    ) : (
                      "—"
                    )}
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
                <TableHead className="text-right">Reading time</TableHead>
                <TableHead>Keywords</TableHead>
                <TableHead>Live</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {published.map((p) => (
                <TableRow key={p.slug}>
                  <TableCell className="font-semibold">{p.title}</TableCell>
                  <TableCell className="text-xs">{p.category_name}</TableCell>
                  <TableCell className="text-xs text-[#5a6a72]">
                    {formatDate(p.publish_date)}
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {p.reading_time_minutes} min
                  </TableCell>
                  <TableCell className="text-xs text-[#5a6a72] max-w-xs truncate">
                    {p.target_keywords.slice(0, 2).join(", ")}
                    {p.target_keywords.length > 2 ? ` +${p.target_keywords.length - 2}` : ""}
                  </TableCell>
                  <TableCell>
                    {p.url ? (
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#287271] font-semibold text-xs underline"
                      >
                        Open
                      </a>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
