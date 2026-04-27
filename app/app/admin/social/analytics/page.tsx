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
import { EngagementInputForm } from "./engagement-input-form";

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

interface AnalyticsSnapshotRow {
  draft_id: string;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  captured_at: string;
}

export default async function SocialAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const brandFilter = normaliseBrand(sp.brand);
  const supabase = await createClient();

  // Per-post performance via vw_post_performance (brand-filtered).
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

  // Latest engagement snapshot per draft_id — used to seed the input form
  // with the most recent values so re-saves are easy.
  const draftIds = performance.map((p) => p.id);
  const snapshotMap = new Map<string, AnalyticsSnapshotRow>();
  if (draftIds.length > 0) {
    const { data: snapshotData } = await supabase
      .schema("social")
      .from("post_analytics")
      .select("draft_id, reactions, comments, shares, captured_at")
      .in("draft_id", draftIds)
      .order("captured_at", { ascending: false });
    for (const row of (snapshotData ?? []) as AnalyticsSnapshotRow[]) {
      // Order is DESC by captured_at; first match per draft_id is the latest
      if (!snapshotMap.has(row.draft_id)) snapshotMap.set(row.draft_id, row);
    }
  }

  // Aggregates across visible posts
  const totalReactions = Array.from(snapshotMap.values()).reduce((s, r) => s + (r.reactions ?? 0), 0);
  const totalComments  = Array.from(snapshotMap.values()).reduce((s, r) => s + (r.comments ?? 0), 0);
  const totalEngagement = totalReactions + totalComments;

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        eyebrow="Social"
        title="Analytics"
        subtitle={
          <span>
            Per-post engagement, logged manually from LinkedIn. LinkedIn doesn&apos;t expose post-level metrics for personal profiles via the API (the read scope is restricted to select developers), so weekly the owner pastes likes + comments here. Thea uses these numbers to shape the next batch of drafts.
          </span>
        }
      />

      <SocialTabs active="analytics" />

      <BrandFilter active={brandFilter} basePath="/social/analytics" />

      <Card className="border-[#cd8b76]/40 bg-[#fbf9f5]">
        <CardContent className="pt-4 text-xs text-[#11242e]">
          <p className="font-bold uppercase tracking-wide text-[10px] text-[#cd8b76] mb-1">Weekly habit (5 mins)</p>
          <p>
            Open each post on LinkedIn (tap the post → tap &quot;View analytics&quot; under the post on mobile, or hover &quot;See more&quot; under the engagement counts on desktop). Type the like + comment counts into the inputs below and hit Save. Re-saving overwrites with the new snapshot.
          </p>
        </CardContent>
      </Card>

      {publishedCount === 0 ? (
        <Card>
          <CardContent className="pt-4 text-xs text-[#5a6a72]">
            No published posts yet for this brand filter. They appear here once they go live via the publishing cron.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatTile label="Published" value={publishedCount} />
            <StatTile label="Total likes" value={totalReactions} />
            <StatTile label="Total comments" value={totalComments} />
            <StatTile label="Total engagement" value={totalEngagement} emphasis="good" />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Per-post performance</CardTitle>
              <p className="text-xs text-[#5a6a72] mt-1">
                Latest snapshot per post. Click published date to open the draft. Type counts and Save to log a new snapshot.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Published</TableHead>
                    <TableHead className="w-1/2">Content</TableHead>
                    <TableHead>Pillar</TableHead>
                    <TableHead>Engagement input</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {performance.map((p) => {
                    const snapshot = snapshotMap.get(p.id);
                    return (
                      <TableRow key={p.id} className="hover:bg-[#f4f1ed]/60">
                        <TableCell className="text-xs whitespace-nowrap align-top">
                          <Link href={`/social/drafts/${p.id}`} className="text-[#cd8b76] hover:text-[#b3412e] font-semibold">
                            {p.published_at ? formatDateTime(p.published_at) : "—"}
                          </Link>
                          <div className="text-[10px] text-[#5a6a72] mt-1">
                            <span className="font-bold uppercase tracking-wide text-[#143643]">{p.brand}</span>
                            <span> · {p.channel.replace(/_/g, " ")}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-[#11242e] whitespace-pre-wrap align-top">
                          {truncate(p.content, 200)}
                        </TableCell>
                        <TableCell className="text-xs text-[#5a6a72] align-top">{p.pillar ?? "—"}</TableCell>
                        <TableCell className="align-top">
                          <EngagementInputForm
                            draftId={p.id}
                            initialReactions={snapshot?.reactions ?? null}
                            initialComments={snapshot?.comments ?? null}
                          />
                          {snapshot ? (
                            <p className="text-[10px] text-[#5a6a72] mt-1">Last logged {formatDateTime(snapshot.captured_at)}</p>
                          ) : (
                            <p className="text-[10px] text-[#5a6a72] mt-1">Not logged yet</p>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
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
