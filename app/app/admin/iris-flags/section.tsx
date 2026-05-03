import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { MarkResolvedButton, ResolveAllButton } from "./mark-resolved-button";

interface FlagRow {
  id: number;
  automation: string;
  ad_id: string | null;
  ad_name: string | null;
  campaign_name: string | null;
  brand: string;
  metric_value: number;
  threshold: number;
  severity: string;
  suggested_action: string;
  details: Record<string, unknown> | null;
  flagged_at: string;
}

const AUTOMATION_LABEL: Record<string, string> = {
  "P1.2": "Creative fatigue",
  "P2.1": "Daily health",
  "P2.2": "CPL anomaly",
  "P2.3": "Pixel/CAPI drift",
};

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatMetric(automation: string, value: number, threshold: number): string {
  if (automation === "P2.3") {
    return `${(value * 100).toFixed(0)}% drift (threshold ${(threshold * 100).toFixed(0)}%)`;
  }
  if (automation === "P2.2") {
    return `£${value.toFixed(2)} CPL (threshold £${threshold.toFixed(2)})`;
  }
  if (automation === "P1.2") {
    return `Frequency ${value.toFixed(2)} (threshold ${threshold.toFixed(2)})`;
  }
  if (automation === "P2.1") {
    return `Pacing ${(value * 100).toFixed(0)}% (threshold ${(threshold * 100).toFixed(0)}%)`;
  }
  return `${value} vs ${threshold}`;
}

// Compact server-rendered section showing active Iris flags. Used on /admin
// overview as a top-of-page card. Owner sees the same row count + queue
// here that they'd see on the full /admin/iris-flags page.
//
// Limit to 5 rows visible by default; "view all" link goes to the full page.
// Empty state shows the "all clear" message + green dot so a quiet day reads
// as positive feedback rather than a missing widget.
export async function IrisFlagsSection({ compact = false }: { compact?: boolean } = {}) {
  const supabase = await createClient();

  const limit = compact ? 5 : 100;
  const { data, error } = await supabase
    .schema("ads_switchable")
    .from("iris_flags")
    .select(
      "id,automation,ad_id,ad_name,campaign_name,brand,metric_value,threshold,severity,suggested_action,details,flagged_at",
    )
    .eq("notified", true)
    .is("read_by_owner_at", null)
    .order("severity", { ascending: false })
    .order("flagged_at", { ascending: true })
    .limit(limit);

  const flags = (data ?? []) as FlagRow[];
  const totalCount = flags.length;

  if (error) {
    return (
      <section className="bg-white border border-[#dad4cb] rounded-xl p-5 shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
        <div className="flex items-baseline gap-3 mb-2">
          <h2 className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">Iris signals</h2>
        </div>
        <p className="text-xs text-[#b3412e]">Error loading flags: {error.message}</p>
      </section>
    );
  }

  return (
    <section className="bg-white border border-[#dad4cb] rounded-xl p-5 shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">Iris signals</h2>
          {totalCount > 0 ? (
            <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#FBE5CB] text-[#b3412e]">
              {totalCount} active
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-[#287271]">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#287271]" />
              All clear
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {totalCount > 1 ? <ResolveAllButton count={totalCount} /> : null}
          {compact && totalCount > 5 ? (
            <Link href="/iris-flags" className="text-[11px] text-[#cd8b76] hover:underline">
              View all →
            </Link>
          ) : null}
        </div>
      </div>

      {totalCount === 0 ? (
        <p className="text-xs text-[#5a6a72] italic">
          No active flags from Iris. Daily check runs at 09:30 BST.
        </p>
      ) : (
        <div className="space-y-2">
          {flags.map((f) => (
            <FlagRowDisplay key={f.id} flag={f} />
          ))}
        </div>
      )}
    </section>
  );
}

function FlagRowDisplay({ flag }: { flag: FlagRow }) {
  const isRed = flag.severity === "red";
  const sevBg = isRed ? "bg-[#cd8b76]" : "bg-[#E9C46A]";
  const sevText = isRed ? "text-white" : "text-[#11242e]";
  const automationLabel = AUTOMATION_LABEL[flag.automation] ?? flag.automation;
  const adLabel =
    flag.ad_name && flag.ad_id
      ? `${flag.ad_name} (${flag.campaign_name ?? "—"})`
      : flag.automation === "P2.3"
        ? "Account-wide"
        : "—";

  return (
    <div className="flex items-start gap-3 p-3 bg-[#FAF3DC]/40 border border-[#E9C46A]/30 rounded-lg">
      <span
        className={`mt-0.5 inline-flex items-center justify-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${sevBg} ${sevText}`}
      >
        {flag.severity}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-xs font-semibold text-[#11242e]">{automationLabel}</span>
          <span className="text-[11px] text-[#5a6a72] truncate">{adLabel}</span>
          <span className="text-[10px] text-[#5a6a72] tabular-nums">{formatAgo(flag.flagged_at)}</span>
        </div>
        <p className="text-[11px] text-[#5a6a72] mt-0.5">
          {formatMetric(flag.automation, Number(flag.metric_value), Number(flag.threshold))}
        </p>
        <p className="text-[11px] text-[#11242e] mt-1 italic">{flag.suggested_action}</p>
      </div>
      <MarkResolvedButton flagId={flag.id} />
    </div>
  );
}
