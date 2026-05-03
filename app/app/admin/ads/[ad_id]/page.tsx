import Link from "next/link";
import { notFound } from "next/navigation";
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

export const dynamic = "force-dynamic";

type Period = "24h" | "7d" | "30d" | "lifetime";

const PERIOD_DAYS: Record<Exclude<Period, "lifetime">, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
};

const PERIOD_LABEL: Record<Period, string> = {
  "24h": "Last 24h",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  lifetime: "Lifetime",
};

function normalisePeriod(v: string | undefined): Period {
  if (v === "24h" || v === "7d" || v === "lifetime") return v;
  return "30d";
}

interface MetaDailyRow {
  ad_id: string | null;
  ad_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_name: string | null;
  date: string;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  frequency: number | null;
  leads: number | null;
  funding_segment: string | null;
}

interface SubmissionRow {
  id: number;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  course_id: string | null;
  is_dq: boolean | null;
  primary_routed_to: string | null;
  submitted_at: string;
}

interface FlagRow {
  id: number;
  automation: string;
  severity: string;
  metric_value: number;
  threshold: number;
  suggested_action: string;
  notified: boolean;
  read_by_owner_at: string | null;
  flagged_at: string;
}

interface EnrolmentRow {
  submission_id: number;
  status: string;
  billed_amount: number | null;
}

const AUTOMATION_LABEL: Record<string, string> = {
  "P1.2": "Creative fatigue",
  "P2.1": "Daily health",
  "P2.2": "CPL anomaly",
  "P2.3": "Pixel/CAPI drift",
};

function gbp(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 2 }).format(n);
}

function intFmt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

function formatDateUK(ymd: string): string {
  return new Date(ymd + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function formatDateTimeUK(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

interface PageProps {
  params: Promise<{ ad_id: string }>;
  searchParams: Promise<{ period?: string }>;
}

export default async function AdDetailPage({ params, searchParams }: PageProps) {
  const { ad_id } = await params;
  const sp = await searchParams;
  const period = normalisePeriod(sp.period);

  const supabase = await createClient();

  let fromISO: string;
  let fromDate: string;
  if (period === "lifetime") {
    fromISO = "2020-01-01T00:00:00Z";
    fromDate = "2020-01-01";
  } else {
    fromISO = new Date(Date.now() - PERIOD_DAYS[period] * 24 * 3600 * 1000).toISOString();
    fromDate = fromISO.slice(0, 10);
  }

  // Pull everything in parallel
  const [metaRes, leadsRes, flagsRes] = await Promise.all([
    supabase
      .schema("ads_switchable")
      .from("meta_daily")
      .select("ad_id,ad_name,campaign_id,campaign_name,adset_name,date,spend,impressions,clicks,ctr,frequency,leads,funding_segment")
      .eq("ad_id", ad_id)
      .gte("date", fromDate)
      .order("date", { ascending: true }),
    supabase
      .schema("leads")
      .from("submissions")
      .select("id,email,first_name,last_name,course_id,is_dq,primary_routed_to,submitted_at")
      .eq("utm_content", ad_id)
      .eq("utm_medium", "paid")
      .is("parent_submission_id", null)
      .gte("submitted_at", fromISO)
      .order("submitted_at", { ascending: false })
      .limit(200),
    supabase
      .schema("ads_switchable")
      .from("iris_flags")
      .select("id,automation,severity,metric_value,threshold,suggested_action,notified,read_by_owner_at,flagged_at")
      .eq("ad_id", ad_id)
      .order("flagged_at", { ascending: false })
      .limit(50),
  ]);

  const metaRows = (metaRes.data ?? []) as MetaDailyRow[];
  const submissions = (leadsRes.data ?? []) as SubmissionRow[];
  const flags = (flagsRes.data ?? []) as FlagRow[];

  // Detail page only renders if the ad has any meta_daily presence at all.
  // If not even an empty array, treat as 404.
  if (metaRes.error || (metaRows.length === 0 && submissions.length === 0)) {
    notFound();
  }

  // Pull enrolments for the qualified+routed leads (Phase 4 closed-loop)
  const submissionIds = submissions.filter((s) => s.primary_routed_to).map((s) => s.id);
  const enrolmentsRes = submissionIds.length
    ? await supabase
        .schema("crm")
        .from("enrolments")
        .select("submission_id,status,billed_amount")
        .in("submission_id", submissionIds)
    : { data: [] as EnrolmentRow[] };
  const enrolmentBySubmissionId = new Map<number, EnrolmentRow>();
  for (const e of (enrolmentsRes.data ?? []) as EnrolmentRow[]) {
    enrolmentBySubmissionId.set(e.submission_id, e);
  }

  // Aggregates
  const latest = metaRows[metaRows.length - 1];
  const adName = latest?.ad_name ?? metaRows[0]?.ad_name ?? ad_id;
  const campaignName = latest?.campaign_name ?? metaRows[0]?.campaign_name ?? null;
  const adsetName = latest?.adset_name ?? metaRows[0]?.adset_name ?? null;
  const fundingSegment = latest?.funding_segment ?? metaRows[0]?.funding_segment ?? null;

  const totalSpend = metaRows.reduce((s, r) => s + Number(r.spend ?? 0), 0);
  const totalImpressions = metaRows.reduce((s, r) => s + Number(r.impressions ?? 0), 0);
  const totalClicks = metaRows.reduce((s, r) => s + Number(r.clicks ?? 0), 0);
  const totalLeadsMeta = metaRows.reduce((s, r) => s + Number(r.leads ?? 0), 0);
  const totalLeadsDb = submissions.length;
  const totalQualified = submissions.filter((s) => !s.is_dq).length;
  const totalRouted = submissions.filter((s) => !s.is_dq && s.primary_routed_to).length;
  const totalEnrolled = submissions.filter(
    (s) => enrolmentBySubmissionId.get(s.id)?.status === "enrolled" || enrolmentBySubmissionId.get(s.id)?.status === "presumed_enrolled",
  ).length;
  const totalRevenue = submissions.reduce((sum, s) => {
    const e = enrolmentBySubmissionId.get(s.id);
    if (e && (e.status === "enrolled" || e.status === "presumed_enrolled")) {
      return sum + Number(e.billed_amount ?? 0);
    }
    return sum;
  }, 0);

  const ctrPeriod = totalImpressions > 0 ? totalClicks / totalImpressions : null;
  const cplTrue = totalQualified > 0 ? totalSpend / totalQualified : null;
  const cpePeriod = totalEnrolled > 0 ? totalSpend / totalEnrolled : null;

  // Per-provider breakdown
  const byProvider = new Map<string, { qualified: number; routed: number; enrolled: number }>();
  for (const s of submissions) {
    if (!s.primary_routed_to) continue;
    const k = s.primary_routed_to;
    const cur = byProvider.get(k) ?? { qualified: 0, routed: 0, enrolled: 0 };
    cur.routed += 1;
    if (!s.is_dq) cur.qualified += 1;
    const e = enrolmentBySubmissionId.get(s.id);
    if (e?.status === "enrolled" || e?.status === "presumed_enrolled") cur.enrolled += 1;
    byProvider.set(k, cur);
  }

  // Trend chart data: max-of-the-period spend axis for scaling
  const maxDailySpend = Math.max(0, ...metaRows.map((r) => Number(r.spend ?? 0)));

  return (
    <div className="max-w-6xl space-y-6">
      <Link href={`/ads?period=${period}`} className="text-xs text-[#cd8b76] hover:underline inline-block">
        ← Back to Ads
      </Link>
      <PageHeader
        eyebrow="Ad detail"
        title={adName}
        subtitle={
          <>
            <span className="font-mono text-[11px]">{ad_id}</span> · {PERIOD_LABEL[period].toLowerCase()}{" "}
            {campaignName ? <>· {campaignName}</> : null}
            {adsetName ? <> · {adsetName}</> : null}
            {fundingSegment ? <> · {fundingSegment}</> : null}
          </>
        }
      />

      <PeriodPills active={period} ad_id={ad_id} />

      {/* Lead funnel tiles */}
      <section>
        <h2 className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">Lead funnel</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <FunnelTile label="Spend" value={gbp(totalSpend)} />
          <FunnelTile label="Meta leads" value={intFmt(totalLeadsMeta)} note="What Meta reports" />
          <FunnelTile label="DB total" value={intFmt(totalLeadsDb)} note="All paid submissions" />
          <FunnelTile label="Qualified" value={intFmt(totalQualified)} note={`${totalLeadsDb > 0 ? Math.round((totalQualified / totalLeadsDb) * 100) : 0}% of DB`} />
          <FunnelTile label="Routed" value={intFmt(totalRouted)} note={`${totalQualified > 0 ? Math.round((totalRouted / totalQualified) * 100) : 0}% of qualified`} />
          <FunnelTile label="Enrolled" value={intFmt(totalEnrolled)} note={totalRouted > 0 ? `${Math.round((totalEnrolled / totalRouted) * 100)}% of routed` : "—"} />
        </div>
      </section>

      {/* Cost tiles */}
      <section>
        <h2 className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">Costs</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <FunnelTile label="True CPL" value={gbp(cplTrue)} highlight />
          <FunnelTile label="Cost per enrolment" value={gbp(cpePeriod)} note="Phase 4 dependent" />
          <FunnelTile label="Revenue" value={gbp(totalRevenue)} note="Billed amount" />
          <FunnelTile label="CTR" value={ctrPeriod !== null ? `${(ctrPeriod * 100).toFixed(2)}%` : "—"} note={`${intFmt(totalClicks)} clicks / ${intFmt(totalImpressions)} impressions`} />
        </div>
      </section>

      {/* Trend chart */}
      {metaRows.length > 0 ? (
        <section>
          <h2 className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">
            Daily spend
          </h2>
          <div className="bg-white border border-[#dad4cb] rounded-xl p-5 shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
            <SpendBars rows={metaRows} maxSpend={maxDailySpend} />
          </div>
        </section>
      ) : null}

      {/* Per-provider breakdown */}
      {byProvider.size > 0 ? (
        <section>
          <h2 className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">
            Per-provider breakdown
          </h2>
          <div className="bg-white border border-[#dad4cb] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead className="text-right">Qualified</TableHead>
                  <TableHead className="text-right">Routed</TableHead>
                  <TableHead className="text-right">Enrolled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Array.from(byProvider.entries())
                  .sort(([, a], [, b]) => b.routed - a.routed)
                  .map(([providerId, c]) => (
                    <TableRow key={providerId}>
                      <TableCell className="text-xs font-semibold">
                        <Link href={`/providers/${providerId}`} className="text-[#cd8b76] hover:underline">
                          {providerId}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{intFmt(c.qualified)}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{intFmt(c.routed)}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{intFmt(c.enrolled)}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}

      {/* Iris flag history for this ad */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">
            Iris flag history
          </h2>
          <Link href="/iris-flags" className="text-[10px] text-[#cd8b76] hover:underline">
            All flags →
          </Link>
        </div>
        {flags.length === 0 ? (
          <p className="text-xs text-[#5a6a72] italic">No flags raised for this ad.</p>
        ) : (
          <div className="bg-white border border-[#dad4cb] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Automation</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {flags.map((f) => {
                  const stateLabel = !f.notified
                    ? "Suppressed"
                    : f.read_by_owner_at
                      ? "Resolved"
                      : "Active";
                  const stateClass = !f.notified
                    ? "bg-[#F4F4F2] text-[#5a6a72]"
                    : f.read_by_owner_at
                      ? "bg-[#DFEAD7] text-[#287271]"
                      : "bg-[#FBE5CB] text-[#b3412e]";
                  const sevClass =
                    f.severity === "red" ? "bg-[#cd8b76] text-white" : "bg-[#E9C46A] text-[#11242e]";
                  return (
                    <TableRow key={f.id}>
                      <TableCell className="text-xs text-[#5a6a72] whitespace-nowrap">
                        {formatDateTimeUK(f.flagged_at)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {AUTOMATION_LABEL[f.automation] ?? f.automation}
                      </TableCell>
                      <TableCell>
                        <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${sevClass}`}>
                          {f.severity}
                        </span>
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

      {/* Recent leads from this ad */}
      <section>
        <h2 className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">
          Leads from this ad ({submissions.length})
        </h2>
        {submissions.length === 0 ? (
          <p className="text-xs text-[#5a6a72] italic">
            No paid leads with this ad_id in the period (utm_medium = paid, parent_submission_id IS NULL).
          </p>
        ) : (
          <div className="bg-white border border-[#dad4cb] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Lead</TableHead>
                  <TableHead>Course</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Routed to</TableHead>
                  <TableHead>Enrolment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {submissions.slice(0, 50).map((s) => {
                  const enrolment = enrolmentBySubmissionId.get(s.id);
                  const fullName = [s.first_name, s.last_name].filter(Boolean).join(" ") || s.email || `#${s.id}`;
                  let stateLabel: string;
                  let stateClass: string;
                  if (s.is_dq) {
                    stateLabel = "DQ";
                    stateClass = "bg-[#F4F4F2] text-[#5a6a72]";
                  } else if (s.primary_routed_to) {
                    stateLabel = "Routed";
                    stateClass = "bg-[#D8E5E2] text-[#287271]";
                  } else {
                    stateLabel = "Open";
                    stateClass = "bg-[#FAF3DC] text-[#11242e]";
                  }
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="text-xs text-[#5a6a72] whitespace-nowrap">
                        {formatDateTimeUK(s.submitted_at)}
                      </TableCell>
                      <TableCell className="text-xs">
                        <Link href={`/leads/${s.id}`} className="text-[#cd8b76] hover:underline font-semibold">
                          {fullName}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs text-[#5a6a72]">{s.course_id ?? "—"}</TableCell>
                      <TableCell>
                        <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold ${stateClass}`}>
                          {stateLabel}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">{s.primary_routed_to ?? "—"}</TableCell>
                      <TableCell className="text-xs">
                        {enrolment ? (
                          <span className="text-[#287271] font-semibold">{enrolment.status}</span>
                        ) : (
                          <span className="text-[#5a6a72]">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {submissions.length > 50 ? (
              <div className="px-4 py-2 text-[10px] text-[#5a6a72] border-t border-[#dad4cb]">
                Showing 50 of {submissions.length}.{" "}
                <Link href={`/leads?utm_content=${ad_id}`} className="text-[#cd8b76] hover:underline">
                  View all in /leads
                </Link>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

function FunnelTile({
  label,
  value,
  note,
  highlight,
}: {
  label: string;
  value: string;
  note?: string;
  highlight?: boolean;
}) {
  const border = highlight ? "border-2 border-[#cd8b76]" : "border border-[#dad4cb]";
  const valueCls = highlight ? "text-[#cd8b76]" : "text-[#11242e]";
  return (
    <div className={`bg-white ${border} rounded-xl p-4`}>
      <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">{label}</p>
      <p className={`text-2xl font-extrabold mt-2 tracking-tight ${valueCls}`}>{value}</p>
      {note ? <p className="text-[10px] text-[#5a6a72] mt-1">{note}</p> : null}
    </div>
  );
}

function PeriodPills({ active, ad_id }: { active: Period; ad_id: string }) {
  const periods: Period[] = ["24h", "7d", "30d", "lifetime"];
  return (
    <div className="flex flex-wrap gap-2">
      {periods.map((p) => {
        const isActive = p === active;
        const href = p === "30d" ? `/ads/${ad_id}` : `/ads/${ad_id}?period=${p}`;
        return (
          <Link
            key={p}
            href={href}
            className={
              isActive
                ? "px-3 h-7 inline-flex items-center text-[10px] font-bold uppercase tracking-[0.08em] rounded-full bg-[#cd8b76] text-white border border-[#cd8b76]"
                : "px-3 h-7 inline-flex items-center text-[10px] font-bold uppercase tracking-[0.08em] rounded-full bg-white text-[#143643] border border-[#dad4cb] hover:border-[#cd8b76]/60"
            }
          >
            {PERIOD_LABEL[p]}
          </Link>
        );
      })}
    </div>
  );
}

// Server-rendered SVG bars chart for daily spend. Pure SVG so no client bundle
// cost; sufficient at pilot scale (≤30 days, ≤30 bars). Each bar height
// proportional to maxSpend across the period; date label every 5th bar so
// short windows show all dates and 30-day windows stay readable.
function SpendBars({ rows, maxSpend }: { rows: MetaDailyRow[]; maxSpend: number }) {
  if (maxSpend === 0) {
    return <p className="text-xs text-[#5a6a72] italic">No spend in this period.</p>;
  }
  const width = 720;
  const height = 200;
  const padTop = 16;
  const padBottom = 28;
  const padLeft = 40;
  const padRight = 12;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;
  const bars = rows.length;
  const barW = chartW / bars - 4;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Daily spend">
      {/* Y-axis baseline */}
      <line x1={padLeft} x2={width - padRight} y1={padTop + chartH} y2={padTop + chartH} stroke="#dad4cb" />
      {/* Y-axis label: max */}
      <text x={padLeft - 6} y={padTop + 4} textAnchor="end" fontSize="10" fill="#5a6a72">
        £{Math.round(maxSpend)}
      </text>
      <text x={padLeft - 6} y={padTop + chartH + 4} textAnchor="end" fontSize="10" fill="#5a6a72">
        £0
      </text>
      {rows.map((r, i) => {
        const spend = Number(r.spend ?? 0);
        const h = maxSpend > 0 ? (spend / maxSpend) * chartH : 0;
        const x = padLeft + i * (chartW / bars) + 2;
        const y = padTop + chartH - h;
        const showLabel = i === 0 || i === rows.length - 1 || i % Math.max(1, Math.floor(rows.length / 6)) === 0;
        return (
          <g key={r.date}>
            <rect x={x} y={y} width={barW} height={h} fill="#287271" rx="2">
              <title>
                {formatDateUK(r.date)}: £{spend.toFixed(2)}, {r.leads ?? 0} Meta leads
              </title>
            </rect>
            {showLabel ? (
              <text
                x={x + barW / 2}
                y={padTop + chartH + 16}
                textAnchor="middle"
                fontSize="10"
                fill="#5a6a72"
              >
                {formatDateUK(r.date)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
