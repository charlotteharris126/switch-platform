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

  if (perfError) {
    return <div className="text-[#b3412e]">Error: {perfError.message}</div>;
  }

  const performance = (perfData ?? []) as PerformanceRow[];
  const publishedCount = performance.length;

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        eyebrow="Social"
        title="Analytics"
        subtitle={
          <span>
            Per-post engagement metrics will populate once Marketing Developer Platform approval lands (LinkedIn gates the read scope). Until then, this page shows post counts only. Approval is in flight.
          </span>
        }
      />

      <SocialTabs active="analytics" />

      <BrandFilter active={brandFilter} basePath="/social/analytics" />

      <Card className="border-[#cd8b76]/60 bg-[#fbf9f5]">
        <CardContent className="pt-4 text-xs text-[#11242e]">
          <p className="font-bold uppercase tracking-wide text-[10px] text-[#cd8b76] mb-1">Engagement metrics — awaiting approval</p>
          <p>
            LinkedIn gates the read scope (<span className="font-mono">r_member_social</span>) behind Marketing Developer Platform approval. Submission is queued; typical wait 2-8 weeks. Once granted, you reconnect on Settings, the analytics-sync cron re-enables, and reactions/comments populate per published post.
          </p>
        </CardContent>
      </Card>

      {publishedCount === 0 ? (
        <Card>
          <CardContent className="pt-4 text-xs text-[#5a6a72]">
            No published posts yet for this brand filter. Once posts go live and the analytics sync has run at least once, they appear here with reaction / comment / share counts.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <StatTile label="Published" value={publishedCount} />
            <StatTile label="Engagement" value="awaiting approval" />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Posts published</CardTitle>
              <p className="text-xs text-[#5a6a72] mt-1">
                Click a post to see its draft + edit history. Engagement column populates once read scope is granted.
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
                      <TableCell className="text-xs text-right text-[#5a6a72]">
                        —
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

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
