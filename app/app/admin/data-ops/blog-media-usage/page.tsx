// /admin/data-ops/blog-media-usage — Supabase Storage bucket usage for
// blog-media. Shows file count, total bytes, biggest files, and a "what
// to do when it fills up" runbook. Reads the bucket via the admin client
// (service role) so RLS doesn't get in the way.

import { PageHeader } from "@/components/page-header";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type FileMeta = {
  name: string;
  size: number;
  updated_at: string | null;
};

// Recursively walks the bucket so subdirectories (per-slug folders) are
// included. Supabase Storage's list API returns only the immediate level
// per call; we have to traverse manually.
async function walkBucket(
  admin: ReturnType<typeof createAdminClient>,
  bucket: string,
  prefix = "",
): Promise<FileMeta[]> {
  const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000, sortBy: { column: "name", order: "asc" } });
  if (error || !data) return [];
  const out: FileMeta[] = [];
  for (const entry of data) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    // Supabase returns a `metadata` field for files (with `.size`) and
    // null metadata for "folders" (which are really key prefixes).
    const meta = (entry as { metadata?: { size?: number } }).metadata;
    if (meta && typeof meta.size === "number") {
      out.push({ name: fullPath, size: meta.size, updated_at: entry.updated_at ?? null });
    } else {
      // It's a folder — recurse.
      const children = await walkBucket(admin, bucket, fullPath);
      out.push(...children);
    }
  }
  return out;
}

export default async function BlogMediaUsagePage() {
  let files: FileMeta[] = [];
  let loadError: string | null = null;
  try {
    const admin = createAdminClient();
    files = await walkBucket(admin, "blog-media");
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const biggest = [...files].sort((a, b) => b.size - a.size).slice(0, 20);

  // Free tier Supabase Storage: 1GB project-wide. Paid plan: 100GB.
  // We approximate "bucket headroom" against a 1GB local soft cap so the
  // bar shows useful colour before we approach the actual hard limit.
  const SOFT_LIMIT_BYTES = 1024 * 1024 * 1024; // 1GB
  const pctUsed = Math.min(100, (totalBytes / SOFT_LIMIT_BYTES) * 100);
  const fmtBytes = (n: number) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  return (
    <div className="max-w-4xl space-y-6 py-6">
      <PageHeader
        eyebrow="Tools"
        title="Blog media usage"
        subtitle="Supabase Storage bucket: blog-media. Lists every cover image + inline post image, total bytes used, and the 20 biggest files. Hard per-file cap: 10 MB."
      />

      {loadError && (
        <p className="text-sm text-[#b3412e] bg-white border border-[#e9b3a4] rounded-md p-3">
          Could not read bucket: {loadError}
        </p>
      )}

      <section className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Stat label="Files" value={String(files.length)} />
        <Stat label="Total used" value={fmtBytes(totalBytes)} />
        <Stat label="vs 1 GB soft cap" value={`${pctUsed.toFixed(1)}%`} />
      </section>

      <section className="bg-white rounded-xl border border-[#e5dfd8] p-4">
        <p className="text-xs font-bold uppercase tracking-wide text-[#5a6a72] mb-2">Headroom</p>
        <div className="h-3 bg-[#f5f2eb] rounded-full overflow-hidden">
          <div
            className="h-full transition-all"
            style={{
              width: `${pctUsed}%`,
              background: pctUsed > 80 ? "#b3412e" : pctUsed > 50 ? "#E97C61" : "#287271",
            }}
          />
        </div>
        <p className="text-xs text-[#5a6a72] mt-2">
          1 GB is the Supabase free-tier project-wide storage limit; paid plans get 100 GB+. Bucket alone hitting 1 GB doesn&apos;t break uploads — it just means the project is getting close.
        </p>
      </section>

      <section className="bg-white rounded-xl border border-[#e5dfd8] overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-[#f5f2eb] text-[#5a6a72] uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-2 font-bold">File</th>
              <th className="text-right px-3 py-2 font-bold">Size</th>
              <th className="text-left px-3 py-2 font-bold">Updated</th>
            </tr>
          </thead>
          <tbody>
            {biggest.length === 0 && (
              <tr><td colSpan={3} className="text-center px-3 py-8 text-[#5a6a72]">No files in bucket yet.</td></tr>
            )}
            {biggest.map((f) => (
              <tr key={f.name} className="border-t border-[#f5f2eb] hover:bg-[#fafaf7]">
                <td className="px-3 py-2 font-mono text-[10px] break-all">{f.name}</td>
                <td className="px-3 py-2 text-right font-mono">{fmtBytes(f.size)}</td>
                <td className="px-3 py-2 text-[10px] text-[#5a6a72]">{f.updated_at ? new Date(f.updated_at).toLocaleDateString("en-GB") : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="bg-[#FAF3DC] border border-[#e9c46a] rounded-xl p-4 text-sm text-[#11242e]">
        <p className="font-extrabold mb-2">When the bucket fills up</p>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>
            <strong>Uploads start failing</strong> with a storage-quota error from Supabase. Existing images still serve, the live blog stays up.
          </li>
          <li>
            <strong>First move</strong>: scan the biggest files above. Anything &gt;500 KB is usually a non-optimised JPEG / PNG. Re-export at 1600×900 max + 75% quality and re-upload. Easy 50-80% size cuts.
          </li>
          <li>
            <strong>Delete orphans</strong>: images uploaded for posts that never published. Cross-check this list against editorial.posts.cover_image_url + body image refs. (Future improvement: an orphans panel that auto-detects.)
          </li>
          <li>
            <strong>If still full</strong>: upgrade Supabase plan (free → Pro is $25/mo, raises project storage to 100 GB). Or offload static images to a cheaper CDN like Bunny.net or Cloudflare R2.
          </li>
        </ol>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-[#e5dfd8] rounded-xl p-3">
      <p className="text-[10px] font-bold uppercase tracking-wide text-[#5a6a72]">{label}</p>
      <p className="text-xl font-extrabold text-[#11242e] mt-1">{value}</p>
    </div>
  );
}
