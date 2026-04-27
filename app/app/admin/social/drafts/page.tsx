import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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

// Drafts review surface. Read-only for now (G.3 first ship). Edit / approve /
// reject / retry actions ship in the next iteration. The 11 batch-loaded
// posts arrive here as status='approved' since they were already reviewed
// during drafting; the cron picks them up at their scheduled_for time.

interface DraftRow {
  id: string;
  brand: string;
  channel: string;
  status: string;
  content: string;
  scheduled_for: string | null;
  pillar: string | null;
  hook_type: string | null;
  external_post_id: string | null;
  published_at: string | null;
  publish_error: string | null;
  created_at: string;
}

const STATUS_GROUPS: Array<{ key: string; label: string; description: string }> = [
  { key: "pending",            label: "Pending review", description: "Awaiting your approve / edit / reject decision." },
  { key: "approved",           label: "Approved",       description: "Queued for publishing. Cron picks them up at their scheduled time." },
  { key: "published",          label: "Published",      description: "Posted to the channel. External post URN recorded." },
  { key: "failed",             label: "Failed",         description: "Publish errored. Review the message and retry or reject." },
  { key: "rejected",           label: "Rejected",       description: "Won't publish. Kept for record + rejection-pattern analysis." },
];

export default async function SocialDraftsPage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema("social")
    .from("drafts")
    .select("id, brand, channel, status, content, scheduled_for, pillar, hook_type, external_post_id, published_at, publish_error, created_at")
    .order("scheduled_for", { ascending: true, nullsFirst: false });

  if (error) {
    return (
      <div className="text-[#b3412e]">
        Error loading drafts: {error.message}
      </div>
    );
  }

  const drafts = (data ?? []) as DraftRow[];

  // Group by status
  const grouped: Record<string, DraftRow[]> = {};
  for (const d of drafts) {
    if (!grouped[d.status]) grouped[d.status] = [];
    grouped[d.status].push(d);
  }

  const totalCount = drafts.length;

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        eyebrow="Social"
        title="Drafts"
        subtitle={
          totalCount === 0 ? (
            <span>No drafts yet. Once Thea&apos;s draft generator is wired (Session G next-tier), pending drafts land here for review.</span>
          ) : (
            <span>{totalCount} {totalCount === 1 ? "draft" : "drafts"} across {Object.keys(grouped).length} status{Object.keys(grouped).length === 1 ? "" : "es"}.</span>
          )
        }
      />

      <SocialTabs active="drafts" />

      {STATUS_GROUPS.map(({ key, label, description }) => {
        const rows = grouped[key] ?? [];
        if (rows.length === 0) return null;
        return (
          <Card key={key}>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                {label}
                <Badge className={statusBadgeClass(key)}>{rows.length}</Badge>
              </CardTitle>
              <p className="text-xs text-[#5a6a72] mt-1">{description}</p>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Scheduled</TableHead>
                    <TableHead>Brand · Channel</TableHead>
                    <TableHead>Pillar</TableHead>
                    <TableHead className="w-1/2">Content preview</TableHead>
                    {key === "published" ? <TableHead>Post URN</TableHead> : null}
                    {key === "failed" ? <TableHead>Error</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((d) => (
                    <TableRow key={d.id} className="hover:bg-[#f4f1ed]/60">
                      <TableCell className="text-xs whitespace-nowrap">
                        <Link href={`/social/drafts/${d.id}`} className="text-[#cd8b76] hover:text-[#b3412e] font-semibold">
                          {d.scheduled_for ? formatDateTime(d.scheduled_for) : "—"}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs text-[#5a6a72]">
                        <span className="font-bold uppercase tracking-wide text-[#143643]">{d.brand}</span>
                        <span> · {d.channel.replace(/_/g, " ")}</span>
                      </TableCell>
                      <TableCell className="text-xs text-[#5a6a72]">{d.pillar ?? "—"}</TableCell>
                      <TableCell className="text-xs text-[#11242e] whitespace-pre-wrap">
                        {truncate(d.content, 200)}
                      </TableCell>
                      {key === "published" ? (
                        <TableCell className="font-mono text-[10px] text-[#5a6a72] break-all">
                          {d.external_post_id ?? "—"}
                        </TableCell>
                      ) : null}
                      {key === "failed" ? (
                        <TableCell className="text-xs text-[#b3412e] break-all">
                          {d.publish_error ?? "—"}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "pending":   return "bg-[#143643] text-white text-[10px] hover:bg-[#143643]";
    case "approved":  return "bg-[#cd8b76] text-white text-[10px] hover:bg-[#cd8b76]";
    case "published": return "bg-emerald-100 text-emerald-800 text-[10px] hover:bg-emerald-100";
    case "failed":    return "bg-red-100 text-red-800 text-[10px] hover:bg-red-100";
    case "rejected":  return "bg-[#dad4cb] text-[#143643] text-[10px] hover:bg-[#dad4cb]";
    default:          return "bg-[#f4f1ed] text-[#5a6a72] text-[10px] hover:bg-[#f4f1ed]";
  }
}
