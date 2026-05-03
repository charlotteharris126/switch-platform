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
import { AdSignalsSection } from "../signals/_components/section";

export const dynamic = "force-dynamic";

type Period = "24h" | "7d" | "30d" | "lifetime";
type Brand = "switchable" | "switchleads";
type FundingFilter = "all" | "funded" | "self-funded" | "loan-funded" | "other";

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

function normaliseBrand(v: string | undefined): Brand {
  return v === "switchleads" ? "switchleads" : "switchable";
}

function normaliseFunding(v: string | undefined): FundingFilter {
  if (v === "funded" || v === "self-funded" || v === "loan-funded" || v === "other") return v;
  return "all";
}

interface MetaDailyRow {
  ad_id: string | null;
  ad_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  date: string;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  frequency: number | null;
  leads: number | null;
  funding_segment: string | null;
}

interface SubmissionLite {
  id: number;
  utm_content: string | null;
  utm_medium: string | null;
  is_dq: boolean | null;
  primary_routed_to: string | null;
  parent_submission_id: number | null;
  submitted_at: string;
}

interface PerAdAggregate {
  ad_id: string;
  ad_name: string | null;
  campaign_name: string | null;
  funding_segment: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  frequency: number | null;
  leads_meta: number;
  leads_db_total: number;
  leads_qualified: number;
  leads_routed: number;
  cpl_true: number | null;
  earliest_date: string;
  active_signals: number;
}

function gbp(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 2 }).format(n);
}

function intFmt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

function pct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(2)}%`;
}

function freq(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

function daysBetween(from: string, to: Date): number {
  const fromD = new Date(from + "T00:00:00Z").getTime();
  const days = Math.floor((to.getTime() - fromD) / (24 * 3600 * 1000));
  return Math.max(1, days + 1);
}

interface PageProps {
  searchParams: Promise<{ period?: string; brand?: string; funding?: string }>;
}

export default async function AdsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const period = normalisePeriod(sp.period);
  const brand = normaliseBrand(sp.brand);
  const funding = normaliseFunding(sp.funding);

  const supabase = await createClient();

  const now = new Date();
  let fromISO: string;
  if (period === "lifetime") fromISO = "2020-01-01T00:00:00Z";
  else fromISO = new Date(Date.now() - PERIOD_DAYS[period] * 24 * 3600 * 1000).toISOString();
  const fromDate = fromISO.slice(0, 10);

  // SwitchLeads brand: dormant. Bail early with placeholder until
  // ads_switchleads schema populates. Brand selector lives in the layout.
  if (brand === "switchleads") {
    return (
      <div className="max-w-6xl space-y-6">
        <PageHeader
          eyebrow="Analytics"
          title="Ads — SwitchLeads"
          subtitle="SwitchLeads B2B ads not yet active. Brand placeholder until ads_switchleads schema populates."
        />
        <p className="text-xs text-[#5a6a72] italic">
          When the SwitchLeads ad account ships, this view will mirror the Switchable layout from
          ads_switchleads.meta_daily.
        </p>
      </div>
    );
  }

  // Pull period-bounded meta_daily and same-period qualified-paid leads in
  // parallel. parent_submission_id IS NULL filter applied for True CPL
  // consistency (per the morning's audit fix).
  const [metaRes, leadsRes, flagsRes] = await Promise.all([
    supabase
      .schema("ads_switchable")
      .from("meta_daily")
      .select("ad_id,ad_name,campaign_id,campaign_name,date,spend,impressions,clicks,ctr,frequency,leads,funding_segment")
      .gte("date", fromDate),
    supabase
      .schema("leads")
      .from("submissions")
      .select("id,utm_content,utm_medium,is_dq,primary_routed_to,parent_submission_id,submitted_at")
      .eq("utm_medium", "paid")
      .is("parent_submission_id", null)
      .gte("submitted_at", fromISO),
    supabase
      .schema("ads_switchable")
      .from("iris_flags")
      .select("ad_id")
      .eq("notified", true)
      .is("read_by_owner_at", null),
  ]);

  const metaRows = (metaRes.data ?? []) as MetaDailyRow[];
  const submissions = (leadsRes.data ?? []) as SubmissionLite[];
  const flagsByAdId = new Map<string, number>();
  for (const f of (flagsRes.data ?? []) as Array<{ ad_id: string | null }>) {
    if (!f.ad_id) continue;
    flagsByAdId.set(f.ad_id, (flagsByAdId.get(f.ad_id) ?? 0) + 1);
  }

  // Build per-ad aggregates
  const adMap = new Map<string, PerAdAggregate>();
  for (const r of metaRows) {
    if (!r.ad_id) continue;
    const a = adMap.get(r.ad_id) ?? {
      ad_id: r.ad_id,
      ad_name: r.ad_name,
      campaign_name: r.campaign_name,
      funding_segment: r.funding_segment,
      spend: 0,
      impressions: 0,
      clicks: 0,
      ctr: null,
      frequency: null,
      leads_meta: 0,
      leads_db_total: 0,
      leads_qualified: 0,
      leads_routed: 0,
      cpl_true: null,
      earliest_date: r.date,
      active_signals: 0,
    };
    a.spend += Number(r.spend ?? 0);
    a.impressions += Number(r.impressions ?? 0);
    a.clicks += Number(r.clicks ?? 0);
    a.leads_meta += Number(r.leads ?? 0);
    if (r.date < a.earliest_date) a.earliest_date = r.date;
    // Take latest metadata snapshot (later rows overwrite earlier for shared fields)
    a.ad_name = r.ad_name ?? a.ad_name;
    a.campaign_name = r.campaign_name ?? a.campaign_name;
    a.funding_segment = r.funding_segment ?? a.funding_segment;
    adMap.set(r.ad_id, a);
  }

  // Compute period-level CTR + frequency from sums (more accurate than averaging
  // daily ctr values which double-count low-volume days).
  for (const a of adMap.values()) {
    a.ctr = a.impressions > 0 ? a.clicks / a.impressions : null;
    // Frequency is impressions/reach, but we don't carry sum(reach) reliably
    // (reach is unique per period, not additive across days). Pull latest day's
    // frequency as a directional read. Acceptable for ranking.
    const latestDay = metaRows
      .filter((r) => r.ad_id === a.ad_id)
      .sort((x, y) => (y.date < x.date ? -1 : 1))[0];
    a.frequency = latestDay?.frequency ?? null;
    a.active_signals = flagsByAdId.get(a.ad_id) ?? 0;
  }

  // Join in DB-side lead counts per ad (via utm_content = ad_id)
  for (const s of submissions) {
    if (!s.utm_content) continue;
    const a = adMap.get(s.utm_content);
    if (!a) continue;
    a.leads_db_total += 1;
    if (!s.is_dq) {
      a.leads_qualified += 1;
      if (s.primary_routed_to) a.leads_routed += 1;
    }
  }

  // True CPL using qualified leads as denominator (matches /admin/profit)
  for (const a of adMap.values()) {
    a.cpl_true = a.leads_qualified > 0 ? a.spend / a.leads_qualified : null;
  }

  // Filter by funding segment if set
  let ads = Array.from(adMap.values());
  if (funding === "other") {
    ads = ads.filter((a) => a.funding_segment === null);
  } else if (funding !== "all") {
    ads = ads.filter((a) => a.funding_segment === funding);
  }

  // Sort: leads_qualified desc, then cpl_true asc (lower is better, NULLs last)
  ads.sort((x, y) => {
    if (y.leads_qualified !== x.leads_qualified) return y.leads_qualified - x.leads_qualified;
    if (x.cpl_true === null && y.cpl_true === null) return 0;
    if (x.cpl_true === null) return 1;
    if (y.cpl_true === null) return -1;
    return x.cpl_true - y.cpl_true;
  });

  // Headline tiles
  const totalSpend = ads.reduce((s, a) => s + a.spend, 0);
  const totalLeadsMeta = ads.reduce((s, a) => s + a.leads_meta, 0);
  const totalQualified = ads.reduce((s, a) => s + a.leads_qualified, 0);
  const totalRouted = ads.reduce((s, a) => s + a.leads_routed, 0);
  const headlineCpl = totalQualified > 0 ? totalSpend / totalQualified : null;

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        eyebrow="Analytics"
        title="Ads"
        subtitle={
          <>
            Per-ad performance across {PERIOD_LABEL[period].toLowerCase()}. Leads + CPL use the True
            (DB-side) qualified-paid count to match{" "}
            <Link href="/profit" className="underline">
              /profit
            </Link>
            . Ad signals link through to{" "}
            <Link href="/analytics/signals" className="underline">
              signal history
            </Link>
            .
          </>
        }
      />

      <FilterBar period={period} brand={brand} funding={funding} />

      {/* Headline tiles */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <Tile label="Spend" value={gbp(totalSpend)} />
        <Tile label="Leads (Meta)" value={intFmt(totalLeadsMeta)} note="What Meta reports" />
        <Tile label="Qualified (DB)" value={intFmt(totalQualified)} note="Pixel-fired + qualified" />
        <Tile label="Routed" value={intFmt(totalRouted)} note={`${totalQualified > 0 ? Math.round((totalRouted / totalQualified) * 100) : 0}% of qualified`} />
        <Tile label="True CPL" value={gbp(headlineCpl)} highlight />
      </div>

      {/* Ad signals card — reuse the same compact section */}
      <AdSignalsSection compact />

      {/* Performance table */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">
            Per-ad performance
          </h2>
          <span className="text-[10px] text-[#5a6a72]">
            {ads.length} ads · sorted by qualified leads desc, then CPL asc
          </span>
        </div>
        {ads.length === 0 ? (
          <p className="text-xs text-[#5a6a72] italic">
            No ads in this window with the current filters.
          </p>
        ) : (
          <div className="bg-white border border-[#dad4cb] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ad</TableHead>
                  <TableHead>Funding</TableHead>
                  <TableHead className="text-right">Days</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Meta leads</TableHead>
                  <TableHead className="text-right">Qualified</TableHead>
                  <TableHead className="text-right">Routed</TableHead>
                  <TableHead className="text-right">True CPL</TableHead>
                  <TableHead className="text-right">CTR</TableHead>
                  <TableHead className="text-right">Freq</TableHead>
                  <TableHead className="text-center">Signal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ads.map((a) => {
                  const days = daysBetween(a.earliest_date, now);
                  return (
                    <TableRow key={a.ad_id}>
                      <TableCell className="text-xs max-w-[220px]">
                        <Link
                          href={`/analytics/ads/${a.ad_id}${period === "30d" ? "" : `?period=${period}`}`}
                          className="font-semibold text-[#11242e] hover:text-[#cd8b76] block truncate"
                          title={a.ad_name ?? ""}
                        >
                          {a.ad_name ?? a.ad_id}
                        </Link>
                        <div className="text-[10px] text-[#5a6a72] truncate" title={a.campaign_name ?? ""}>
                          {a.campaign_name ?? "—"}
                        </div>
                      </TableCell>
                      <TableCell className="text-[11px]">
                        {a.funding_segment ? (
                          <span
                            className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold ${
                              a.funding_segment === "funded"
                                ? "bg-[#D8E5E2] text-[#287271]"
                                : a.funding_segment === "self-funded"
                                  ? "bg-[#FCE1D6] text-[#cd8b76]"
                                  : "bg-[#F7EAC0] text-[#11242e]"
                            }`}
                          >
                            {a.funding_segment}
                          </span>
                        ) : (
                          <span className="text-[10px] text-[#5a6a72] italic">other</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{days}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums font-bold">
                        {gbp(a.spend)}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-[#5a6a72]">
                        {intFmt(a.leads_meta)}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        {intFmt(a.leads_qualified)}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        {intFmt(a.leads_routed)}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums font-bold">
                        {gbp(a.cpl_true)}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-[#5a6a72]">
                        {pct(a.ctr)}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-[#5a6a72]">
                        {freq(a.frequency)}
                      </TableCell>
                      <TableCell className="text-center">
                        {a.active_signals > 0 ? (
                          <Link href="/analytics/signals" title={`${a.active_signals} active flag(s)`}>
                            <span className="inline-block w-2 h-2 rounded-full bg-[#cd8b76]" />
                          </Link>
                        ) : (
                          <span className="inline-block w-2 h-2 rounded-full bg-[#dad4cb]" />
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <p className="text-[10px] text-[#5a6a72] italic">
        Per-ad drill-down (lead funnel, per-provider breakdown, trend chart, creative preview) is
        stage 4b — deferred to a future session. Stage 1d (delivery state, daily budget, headline,
        primary text) populates after Meta Business Verification clears.
      </p>
    </div>
  );
}

function Tile({
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

// BrandTabs removed: brand selector now lives in the analytics layout.

function FilterBar({ period, brand, funding }: { period: Period; brand: Brand; funding: FundingFilter }) {
  function buildHref(opts: { period?: Period; funding?: FundingFilter }): string {
    const usp = new URLSearchParams();
    const p = opts.period ?? period;
    const f = opts.funding ?? funding;
    if (brand !== "switchable") usp.set("brand", brand);
    if (p !== "30d") usp.set("period", p);
    if (f !== "all") usp.set("funding", f);
    const qs = usp.toString();
    return qs ? `/analytics/ads?${qs}` : "/analytics/ads";
  }

  const periods: Period[] = ["24h", "7d", "30d", "lifetime"];
  const fundings: FundingFilter[] = ["all", "funded", "self-funded", "loan-funded", "other"];

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex flex-wrap gap-2">
        {periods.map((p) => {
          const isActive = p === period;
          return (
            <Link
              key={p}
              href={buildHref({ period: p })}
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
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">Funding</span>
        {fundings.map((f) => {
          const isActive = f === funding;
          return (
            <Link
              key={f}
              href={buildHref({ funding: f })}
              className={
                isActive
                  ? "px-3 h-7 inline-flex items-center text-[10px] font-bold uppercase tracking-[0.08em] rounded-full bg-[#143643] text-white border border-[#143643]"
                  : "px-3 h-7 inline-flex items-center text-[10px] font-bold uppercase tracking-[0.08em] rounded-full bg-white text-[#143643] border border-[#dad4cb] hover:border-[#143643]/40"
              }
            >
              {f}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
