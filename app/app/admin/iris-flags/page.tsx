import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { IrisFlagsSection } from "./section";

export const dynamic = "force-dynamic";

const AUTOMATION_LABEL: Record<string, string> = {
  "P1.2": "Creative fatigue",
  "P2.1": "Daily health",
  "P2.2": "CPL anomaly",
  "P2.3": "Pixel/CAPI drift",
};

interface FlagHistoryRow {
  id: number;
  automation: string;
  ad_id: string | null;
  ad_name: string | null;
  campaign_name: string | null;
  metric_value: number;
  threshold: number;
  severity: string;
  notified: boolean;
  read_by_owner_at: string | null;
  flagged_at: string;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatMetric(automation: string, value: number, threshold: number): string {
  if (automation === "P2.3") return `${(value * 100).toFixed(1)}% / ${(threshold * 100).toFixed(0)}%`;
  if (automation === "P2.2") return `£${value.toFixed(2)} / £${threshold.toFixed(2)}`;
  if (automation === "P1.2") return `${value.toFixed(2)} / ${threshold.toFixed(2)}`;
  if (automation === "P2.1") return `${(value * 100).toFixed(0)}% / ${(threshold * 100).toFixed(0)}%`;
  return `${value} / ${threshold}`;
}

export default async function IrisFlagsPage() {
  const supabase = await createClient();

  // Recent history: last 30 days, all flags including resolved + suppressed
  // (notified = false) for the audit trail.
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { data: historyData, error: historyError } = await supabase
    .schema("ads_switchable")
    .from("iris_flags")
    .select(
      "id,automation,ad_id,ad_name,campaign_name,metric_value,threshold,severity,notified,read_by_owner_at,flagged_at",
    )
    .gte("flagged_at", cutoff)
    .order("flagged_at", { ascending: false })
    .limit(200);

  const history = (historyData ?? []) as FlagHistoryRow[];

  // Aggregate counts per automation for the summary tiles
  const counts: Record<string, { active: number; resolved: number; suppressed: number }> = {
    "P1.2": { active: 0, resolved: 0, suppressed: 0 },
    "P2.1": { active: 0, resolved: 0, suppressed: 0 },
    "P2.2": { active: 0, resolved: 0, suppressed: 0 },
    "P2.3": { active: 0, resolved: 0, suppressed: 0 },
  };
  for (const r of history) {
    const bucket = counts[r.automation];
    if (!bucket) continue;
    if (!r.notified) bucket.suppressed += 1;
    else if (r.read_by_owner_at) bucket.resolved += 1;
    else bucket.active += 1;
  }

  return (
    <div className="max-w-6xl space-y-8">
      <PageHeader
        eyebrow="Tools"
        title="Iris flags"
        subtitle={
          historyError ? (
            <span className="text-[#b3412e]">Error loading history: {historyError.message}</span>
          ) : (
            <>
              Daily ads-performance flag history. Iris runs at 09:30 BST and writes to{" "}
              <code className="text-[11px]">ads_switchable.iris_flags</code>. Active flags also surface on the{" "}
              <Link href="/" className="text-[#cd8b76] hover:underline">
                overview
              </Link>
              .
            </>
          )
        }
      />

      {/* Live active queue, mark-resolved actions live here too */}
      <IrisFlagsSection compact={false} />

      {/* Per-automation summary */}
      <section>
        <h2 className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">
          Last 30 days, by automation
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {(["P1.2", "P2.1", "P2.2", "P2.3"] as const).map((automation) => {
            const c = counts[automation];
            const total = c.active + c.resolved + c.suppressed;
            return (
              <div
                key={automation}
                className="bg-white border border-[#dad4cb] rounded-xl p-4 shadow-[0_1px_2px_rgba(17,36,46,0.04)]"
              >
                <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">
                  {AUTOMATION_LABEL[automation]}
                </p>
                <p className="text-[10px] text-[#5a6a72] mt-0.5">{automation}</p>
                <p className="text-2xl font-extrabold text-[#11242e] mt-3 tracking-tight tabular-nums">
                  {total}
                </p>
                <div className="text-[11px] text-[#5a6a72] mt-2 space-y-0.5">
                  <p>{c.active} active</p>
                  <p>{c.resolved} resolved</p>
                  <p>{c.suppressed} suppressed</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Full history table */}
      <section>
        <h2 className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">
          History (last 30 days, newest first)
        </h2>
        {history.length === 0 ? (
          <p className="text-xs text-[#5a6a72] italic">No flag history in the last 30 days.</p>
        ) : (
          <div className="bg-white border border-[#dad4cb] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Flagged</TableHead>
                  <TableHead>Automation</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Ad</TableHead>
                  <TableHead className="text-right">Metric / threshold</TableHead>
                  <TableHead>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((r) => {
                  let stateLabel: string;
                  let stateClass: string;
                  if (!r.notified) {
                    stateLabel = "Suppressed (7-day)";
                    stateClass = "bg-[#F4F4F2] text-[#5a6a72]";
                  } else if (r.read_by_owner_at) {
                    stateLabel = `Resolved ${formatDateTime(r.read_by_owner_at)}`;
                    stateClass = "bg-[#DFEAD7] text-[#287271]";
                  } else {
                    stateLabel = "Active";
                    stateClass = "bg-[#FBE5CB] text-[#b3412e]";
                  }

                  const sevClass =
                    r.severity === "red"
                      ? "bg-[#cd8b76] text-white"
                      : "bg-[#E9C46A] text-[#11242e]";

                  return (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs text-[#5a6a72] tabular-nums whitespace-nowrap">
                        {formatDateTime(r.flagged_at)}
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="font-semibold">{AUTOMATION_LABEL[r.automation] ?? r.automation}</div>
                        <div className="text-[10px] text-[#5a6a72]">{r.automation}</div>
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${sevClass}`}
                        >
                          {r.severity}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.ad_name ?? (r.automation === "P2.3" ? <span className="text-[#5a6a72] italic">Account-wide</span> : "—")}
                        {r.campaign_name ? (
                          <div className="text-[10px] text-[#5a6a72]">{r.campaign_name}</div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        {formatMetric(r.automation, Number(r.metric_value), Number(r.threshold))}
                      </TableCell>
                      <TableCell>
                        <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold ${stateClass}`}>
                          {stateLabel}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
