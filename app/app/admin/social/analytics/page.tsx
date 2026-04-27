import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { formatDateTime, truncate } from "@/lib/format";
import { SocialTabs } from "../tabs";
import { BrandFilter, normaliseBrand } from "../brand-filter";

interface SearchParams {
  brand?: string;
}

interface PerformanceRow {
  id: string;
  brand: string;
  channel: string;
  pillar: string | null;
  content: string;
  published_at: string | null;
  latest_impressions: number | null;
  latest_engagement: number | null;
}

interface AnalyticsRow {
  draft_id: string;
  captured_at: string;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  follower_count: number | null;
}

export default async function SocialAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const brandFilter = normaliseBrand(sp.brand);
  const supabase = await createClient();

  // vw_post_performance gives us the aggregate (latest reactions+comments+shares)
  // per published post. Brand-filtered.
  let perfQuery = supabase
    .schema("social")
    .from("vw_post_performance")
    .select("id, brand, channel, pillar, content, published_at, latest_impressions, latest_engagement")
    .order("published_at", { ascending: false, nullsFirst: false });

  if (brandFilter !== "all") {
    perfQuery = perfQuery.eq("brand", brandFilter);
  }

  const { data: perfData, error: perfError } = await perfQuery;

  // Latest follower-count snapshot. social.post_analytics carries it on every
  // capture; pull the most recent row for each (brand, channel) via a separate
  // query.
  const { data: latestSnapshot } = await supabase
    .schema("social")
    .from("post_analytics")
    .select("draft_id, captured_at, reactions, comments, shares, follower_count")
    .order("captured_at", { ascending: false })
    .limit(1);

  if (perfError) {
    return <div className="text-[#b3412e]">Error: {perfError.message}</div>;
  }

  const performance = (perfData ?? []) as PerformanceRow[];
  const followerSnapshot = (latestSnapshot ?? [])[0] as AnalyticsRow | undefined;

  // Aggregate stats across visible posts
  const publishedCount = performance.length;
  const totalEngagement = performance.reduce((sum, p) => sum + (p.latest_engagement ?? 0), 0);
  const totalImpressions = performance.reduce((sum, p) => sum + (p.latest_impressions ?? 0), 0);
  const avgEngagement = publishedCount > 0 ? Math.round(totalEngagement / publishedCount) : 0;

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        eyebrow="Social"
        title="Analytics"
        subtitle={
          <span>
            Per-post performance from the daily LinkedIn analytics sync. Reactions, comments, shares pulled via the LinkedIn API. Impressions on personal posts aren&apos;t reliably exposed by LinkedIn&apos;s public API — those activate later via company-page scope.
          </span>
        }
      />

      <SocialTabs active="analytics" />

      <BrandFilter active={brandFilter} basePath="/social/analytics" />

      {publishedCount === 0 ? (
        <Card>
          <CardContent className="pt-4 text-xs text-[#5a6a72]">
            No published posts yet for this brand filter. Once posts go live and the analytics sync has run at least once, they appear here with reaction / comment / share counts.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatTile label="Published" value={publishedCount} />
            <StatTile label="Total engagement" value={totalEngagement} emphasis="good" />
            <StatTile label="Avg per post" value={avgEngagement} />
            <StatTile label="Followers" value={followerSnapshot?.follower_count ?? "—"} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Per-post performance</CardTitle>
              <p className="text-xs text-[#5a6a72] mt-1">
                Latest snapshot from the daily sync. Click a post to see its draft + edit history.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Published</TableHead>
                    <TableHead>Brand · Channel</TableHead>
                    <TableHead>Pillar</TableHead>
                    <TableHead className="w-1/2">Content</TableHead>
                    <TableHead className="text-right">Engagement</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {performance.map((p) => (
                    <TableRow key={p.id} className="hover:bg-[#f4f1ed]/60">
                      <TableCell className="text-xs whitespace-nowrap">
                        <Link href={`/social/drafts/${p.id}`} className="text-[#cd8b76] hover:text-[#b3412e] font-semibold">
                          {p.published_at ? formatDateTime(p.published_at) : "—"}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs text-[#5a6a72]">
                        <span className="font-bold uppercase tracking-wide text-[#143643]">{p.brand}</span>
                        <span> · {p.channel.replace(/_/g, " ")}</span>
                      </TableCell>
                      <TableCell className="text-xs text-[#5a6a72]">{p.pillar ?? "—"}</TableCell>
                      <TableCell className="text-xs text-[#11242e] whitespace-pre-wrap">
                        {truncate(p.content, 180)}
                      </TableCell>
                      <TableCell className="text-xs text-right font-bold text-[#143643]">
                        {p.latest_engagement ?? 0}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      <Card className="border-dashed">
        <CardContent className="pt-4 text-xs text-[#5a6a72]">
          <p className="font-bold uppercase tracking-wide text-[10px] text-[#143643] mb-1">Coming soon</p>
          <p>
            Pillar / hook breakdown, week-over-week trend, ICP engager log integration. For now, raw per-post numbers above are the foundation.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function StatTile({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: number | string;
  emphasis?: "good" | "warn";
}) {
  const valueColor =
    emphasis === "good" ? "text-emerald-700" :
    emphasis === "warn" ? "text-[#cd8b76]" :
    "text-[#11242e]";
  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-4">
      <p className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">{label}</p>
      <p className={`text-3xl font-extrabold mt-1 tracking-tight ${valueColor}`}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
    </div>
  );
}
