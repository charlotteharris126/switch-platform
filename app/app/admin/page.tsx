import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { RealtimeRefresh } from "@/components/realtime-refresh";

interface ProviderBillingRow {
  provider_id: string;
  company_name: string;
  active: boolean;
  total_routed: number;
  confirmed_enrolled: number;
  presumed_enrolled: number;
  free_enrolments_remaining: number;
  billable_count: number;
  conversion_rate_pct: number | null;
}

interface ProviderRow {
  provider_id: string;
  company_name: string;
  per_enrolment_fee: number | null;
  pricing_model: string | null;
}

type Period = "2d" | "7d" | "30d" | "lifetime";

const PERIOD_DAYS: Record<Period, number | null> = {
  "2d": 2,
  "7d": 7,
  "30d": 30,
  "lifetime": null,
};

const PERIOD_LABEL: Record<Period, string> = {
  "2d": "Last 2 days",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "lifetime": "Lifetime",
};

function normalisePeriod(v: string | undefined): Period {
  if (v === "2d" || v === "30d" || v === "lifetime") return v;
  return "7d";
}

const NOW = () => new Date();
const DAYS_AGO_ISO = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

function distinctEmails(rows: Array<{ email: string | null }> | null | undefined): number {
  return new Set(
    (rows ?? [])
      .map((r) => r.email?.toLowerCase().trim() ?? "")
      .filter((e) => e.length > 0),
  ).size;
}

function delta(thisP: number, lastP: number, unit = ""): { sign: "up" | "down" | "flat"; label: string } {
  if (thisP === lastP) return { sign: "flat", label: "no change" };
  const diff = thisP - lastP;
  return {
    sign: diff > 0 ? "up" : "down",
    label: lastP === 0 ? `from 0${unit}` : `${diff > 0 ? "+" : ""}${diff}${unit} vs prior period`,
  };
}

function deltaCurrency(thisP: number, lastP: number): { sign: "up" | "down" | "flat"; label: string } {
  if (thisP === lastP) return { sign: "flat", label: "no change" };
  const diff = thisP - lastP;
  return {
    sign: diff > 0 ? "up" : "down",
    label: lastP === 0 ? `from £0` : `${diff > 0 ? "+" : ""}${gbp(diff)} vs prior period`,
  };
}

function gbp(n: number | null): string {
  if (n === null) return "—";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(n);
}

function pct(n: number | null): string {
  if (n === null) return "—";
  return `${n.toFixed(1)}%`;
}

export default async function AdminHomePage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const sp = await searchParams;
  const period = normalisePeriod(sp.period);
  const days = PERIOD_DAYS[period];

  const supabase = await createClient();

  // Window: this period + prior period for delta calc.
  // Lifetime → no upper window for "this period" and no prior period.
  const thisStart = days === null ? null : DAYS_AGO_ISO(days);
  const lastStart = days === null ? null : DAYS_AGO_ISO(days * 2);

  const applyThis = <T extends { gte: (col: string, val: string) => T }>(q: T, col: string): T =>
    thisStart ? q.gte(col, thisStart) : q;
  const applyLast = <T extends { gte: (col: string, val: string) => T; lt: (col: string, val: string) => T }>(
    q: T,
    col: string,
  ): T => (thisStart && lastStart ? q.gte(col, lastStart).lt(col, thisStart) : q);

  // Lifetime always-on counts (used for conversion rate, free-3 status, scoreboard).
  // These don't take the period selector.
  const [
    // Pace queries (period-aware via this/last)
    leadsThisRes,
    leadsLastRes,
    routedThisRes,
    routedLastRes,
    enrolThisRes,
    enrolLastRes,
    metaSpendThisRes,
    metaSpendLastRes,
    // Lifetime always-on
    routedAllTimeRes,
    confirmedEnrolAllTimeRes,
    presumedEnrolAllTimeRes,
    // Provider state (lifetime)
    billingRes,
    providersRes,
    // Attention surfaces (point-in-time)
    unroutedRes,
    presumedAttentionRes,
    disputedRes,
    errorsRes,
    presumedListRes,
    pendingAiRes,
  ] = await Promise.all([
    // Leads in: distinct emails of non-DQ submissions
    applyThis(
      supabase.schema("leads").from("submissions").select("email").eq("is_dq", false).is("archived_at", null),
      "submitted_at",
    ),
    applyLast(
      supabase.schema("leads").from("submissions").select("email").eq("is_dq", false).is("archived_at", null),
      "submitted_at",
    ),
    // Sent to providers
    applyThis(
      supabase.schema("leads").from("submissions").select("email").not("primary_routed_to", "is", null).is("archived_at", null),
      "routed_at",
    ),
    applyLast(
      supabase.schema("leads").from("submissions").select("email").not("primary_routed_to", "is", null).is("archived_at", null),
      "routed_at",
    ),
    // Enrolments confirmed
    applyThis(
      supabase.schema("crm").from("enrolments").select("id", { count: "exact", head: true }).eq("status", "enrolled"),
      "status_updated_at",
    ),
    applyLast(
      supabase.schema("crm").from("enrolments").select("id", { count: "exact", head: true }).eq("status", "enrolled"),
      "status_updated_at",
    ),
    // Meta ad spend (and Meta-reported leads, used for the secondary CPL line).
    days === null
      ? supabase.schema("ads_switchable").from("meta_daily").select("spend, leads")
      : supabase.schema("ads_switchable").from("meta_daily").select("spend, leads").gte("date", thisStart!.slice(0, 10)),
    days === null
      ? Promise.resolve({ data: [] as Array<{ spend: number | null; leads: number | null }> })
      : supabase
          .schema("ads_switchable")
          .from("meta_daily")
          .select("spend, leads")
          .gte("date", lastStart!.slice(0, 10))
          .lt("date", thisStart!.slice(0, 10)),
    // Lifetime: total routed, confirmed enrolments, presumed enrolments
    supabase.schema("leads").from("submissions").select("email").not("primary_routed_to", "is", null).is("archived_at", null),
    supabase.schema("crm").from("enrolments").select("id", { count: "exact", head: true }).eq("status", "enrolled"),
    supabase.schema("crm").from("enrolments").select("id", { count: "exact", head: true }).eq("status", "presumed_enrolled"),
    // Provider state
    supabase
      .schema("crm")
      .from("vw_provider_billing_state")
      .select("provider_id, company_name, active, total_routed, confirmed_enrolled, presumed_enrolled, free_enrolments_remaining, billable_count, conversion_rate_pct")
      .order("total_routed", { ascending: false }),
    supabase.schema("crm").from("providers").select("provider_id, company_name, per_enrolment_fee, pricing_model"),
    // Attention
    supabase
      .schema("leads")
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("is_dq", false)
      .is("primary_routed_to", null)
      .is("archived_at", null),
    supabase.schema("crm").from("enrolments").select("id", { count: "exact", head: true }).eq("status", "presumed_enrolled"),
    supabase.schema("crm").from("enrolments").select("id", { count: "exact", head: true }).not("disputed_at", "is", null),
    supabase.schema("leads").from("dead_letter").select("id", { count: "exact", head: true }).is("replayed_at", null),
    supabase
      .schema("crm")
      .from("enrolments")
      .select("id, status_updated_at, provider_id")
      .eq("status", "presumed_enrolled")
      .order("status_updated_at", { ascending: true })
      .limit(1),
    supabase.schema("crm").from("pending_updates").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ]);

  // Pace
  const leadsThis = distinctEmails(leadsThisRes.data as Array<{ email: string | null }>);
  const leadsLast = distinctEmails(leadsLastRes.data as Array<{ email: string | null }>);
  const routedThis = distinctEmails(routedThisRes.data as Array<{ email: string | null }>);
  const routedLast = distinctEmails(routedLastRes.data as Array<{ email: string | null }>);
  const enrolThis = enrolThisRes.count ?? 0;
  const enrolLast = enrolLastRes.count ?? 0;

  // Conversion (lifetime)
  const totalRoutedLifetime = distinctEmails(routedAllTimeRes.data as Array<{ email: string | null }>);
  const confirmedAllTime = confirmedEnrolAllTimeRes.count ?? 0;
  const presumedAllTime = presumedEnrolAllTimeRes.count ?? 0;
  const conversionConfirmedPct =
    totalRoutedLifetime > 0 ? Math.round((confirmedAllTime / totalRoutedLifetime) * 1000) / 10 : null;
  const conversionPotentialPct =
    totalRoutedLifetime > 0
      ? Math.round(((confirmedAllTime + presumedAllTime) / totalRoutedLifetime) * 1000) / 10
      : null;

  // Provider/money state
  const billingRows = (billingRes.data ?? []) as ProviderBillingRow[];
  const providers = (providersRes.data ?? []) as ProviderRow[];
  const providerMeta = new Map(providers.map((p) => [p.provider_id, p]));

  // Revenue calcs.
  // - Confirmed-only billable per provider = max(0, confirmed_enrolled - 3).
  //   This is the cash that's lock-in (no dispute risk).
  // - Potential billable per provider = billable_count from the view, which
  //   already includes presumed (presumed counts toward billing per pilot rule
  //   in business.md). This is the cash we'd earn if no presumed gets disputed.
  let revenueConfirmedGBP = 0;
  let revenuePotentialGBP = 0;
  let revenueIncomplete = false;
  for (const r of billingRows) {
    const meta = providerMeta.get(r.provider_id);
    if (!meta) continue;
    const fee = meta.per_enrolment_fee !== null ? Number(meta.per_enrolment_fee) : null;
    if (meta.pricing_model === "per_enrolment_flat" && fee !== null) {
      const confirmedBillable = Math.max(0, r.confirmed_enrolled - 3);
      revenueConfirmedGBP += confirmedBillable * fee;
      revenuePotentialGBP += r.billable_count * fee;
    } else if (meta.pricing_model === "per_enrolment_percent" && r.billable_count > 0) {
      revenueIncomplete = true;
    }
  }

  // Meta ad spend
  const metaSpendThisRows = (metaSpendThisRes.data ?? []) as Array<{ spend: number | null; leads: number | null }>;
  const metaSpendLastRows = (metaSpendLastRes.data ?? []) as Array<{ spend: number | null; leads: number | null }>;
  const metaSpendThis = metaSpendThisRows.reduce((s, r) => s + Number(r.spend ?? 0), 0);
  const metaSpendLast = metaSpendLastRows.reduce((s, r) => s + Number(r.spend ?? 0), 0);
  const metaLeadsThis = metaSpendThisRows.reduce((s, r) => s + Number(r.leads ?? 0), 0);
  const metaIngestionLive = metaSpendThisRows.length > 0 || metaSpendLastRows.length > 0;
  // True CPL: Meta spend ÷ qualified leads in our DB.
  const cplThisPeriod = metaIngestionLive && leadsThis > 0 ? metaSpendThis / leadsThis : null;
  // Meta-reported CPL: what Meta thinks each lead costs (pixel/CAPI count).
  const metaCplThisPeriod = metaIngestionLive && metaLeadsThis > 0 ? metaSpendThis / metaLeadsThis : null;
  // Profit/loss this period: revenue earned this period (currently null until
  // billable enrolments confirm in-period) minus ad spend this period.
  // Once revenue starts flowing this becomes meaningful per period.
  const profitLossThisPeriod = metaIngestionLive ? -metaSpendThis : null;

  const totalFreeRemaining = billingRows.reduce((s, r) => s + (r.free_enrolments_remaining ?? 0), 0);
  const totalFreeUsed = billingRows.reduce((s, r) => s + Math.min(3, r.confirmed_enrolled + r.presumed_enrolled), 0);
  const totalFreeAvailable = billingRows.length * 3;

  // Attention
  const unrouted = unroutedRes.count ?? 0;
  const presumed = presumedAttentionRes.count ?? 0;
  const disputed = disputedRes.count ?? 0;
  const errors = errorsRes.count ?? 0;
  const aiPending = pendingAiRes.count ?? 0;
  const totalAttention = unrouted + presumed + disputed + errors + aiPending;

  // First billable date
  const earliestPresumed = ((presumedListRes.data ?? []) as Array<{ status_updated_at: string }>)[0];
  const firstBillableDate = earliestPresumed
    ? new Date(new Date(earliestPresumed.status_updated_at).getTime() + 21 * 24 * 3600 * 1000)
    : null;
  const firstBillableDateLabel = firstBillableDate
    ? firstBillableDate.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
    : null;
  const daysToFirstBillable = firstBillableDate
    ? Math.ceil((firstBillableDate.getTime() - NOW().getTime()) / (24 * 3600 * 1000))
    : null;

  return (
    <div className="max-w-6xl space-y-8">
      <RealtimeRefresh
        tables={[
          { schema: "leads", table: "submissions" },
          { schema: "crm", table: "enrolments" },
          { schema: "crm", table: "pending_updates" },
          { schema: "leads", table: "dead_letter" },
        ]}
      />
      <PageHeader
        eyebrow="Overview"
        title="Business health"
        subtitle={
          <span>
            {PERIOD_LABEL[period]} for pace + ad spend. Conversion + revenue + provider state are lifetime.
          </span>
        }
      />

      <PeriodPills active={period} />

      {/* Section 1: Pace */}
      <section>
        <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">
          Pace ({PERIOD_LABEL[period].toLowerCase()})
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <PaceTile
            label="Leads in"
            value={leadsThis}
            delta={period === "lifetime" ? null : delta(leadsThis, leadsLast)}
            href="/leads?dq=no"
          />
          <PaceTile
            label="Sent to providers"
            value={routedThis}
            delta={period === "lifetime" ? null : delta(routedThis, routedLast)}
            href="/leads?stage=routed"
          />
          <PaceTile
            label="Enrolments confirmed"
            value={enrolThis}
            delta={period === "lifetime" ? null : delta(enrolThis, enrolLast)}
            href="/leads?stage=enrolled"
            theme="good"
          />
          <PaceTile
            label="Meta ad spend"
            value={metaIngestionLive ? gbp(metaSpendThis) : "—"}
            delta={
              period === "lifetime"
                ? null
                : metaIngestionLive
                  ? deltaCurrency(metaSpendThis, metaSpendLast)
                  : { sign: "flat", label: "Click to add daily totals" }
            }
            href="/profit"
          />
        </div>
      </section>

      {/* Section 2: Conversion (lifetime) */}
      <section>
        <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">Conversion (lifetime)</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ConversionTile
            label="Confirmed conversion"
            value={pct(conversionConfirmedPct)}
            note={`${confirmedAllTime} confirmed enrolments / ${totalRoutedLifetime} unique people sent`}
          />
          <ConversionTile
            label="Potential conversion"
            value={pct(conversionPotentialPct)}
            note={`+ ${presumedAllTime} presumed = ${confirmedAllTime + presumedAllTime} possible / ${totalRoutedLifetime}`}
            theme="good"
          />
        </div>
      </section>

      {/* Section 3: Money */}
      <section>
        <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">Money (lifetime)</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MoneyTile
            label="Revenue confirmed"
            value={gbp(revenueConfirmedGBP)}
            note="Earned, no dispute risk"
            theme="good"
          />
          <MoneyTile
            label="Revenue potential"
            value={gbp(revenuePotentialGBP)}
            note={revenueIncomplete ? "Incl. presumed; plus % of CD" : "Incl. presumed enrolments"}
          />
          <MoneyTile
            label="True CPL"
            value={cplThisPeriod === null ? "—" : gbp(cplThisPeriod)}
            note={
              !metaIngestionLive
                ? "Awaiting Meta ingestion"
                : metaCplThisPeriod === null
                  ? `Spend ÷ ${leadsThis} DB leads`
                  : `Meta reports ${gbp(metaCplThisPeriod)} (cookie-blocked)`
            }
          />
          <MoneyTile
            label="First billable hits"
            value={firstBillableDateLabel ?? "Not yet"}
            note={
              firstBillableDateLabel
                ? `${daysToFirstBillable === 1 ? "tomorrow" : daysToFirstBillable === 0 ? "today" : daysToFirstBillable !== null && daysToFirstBillable < 0 ? `${Math.abs(daysToFirstBillable)} days ago, chase` : `in ${daysToFirstBillable} days`}`
                : "No presumed enrolments yet"
            }
          />
        </div>
        <p className="text-[10px] text-[#5a6a72] mt-3 italic">
          Pilot deal: first 3 enrolments per provider are free. Currently {totalFreeUsed} of {totalFreeAvailable} free
          slots used across {billingRows.length} provider{billingRows.length === 1 ? "" : "s"} ({totalFreeRemaining}{" "}
          remaining). Revenue figures already exclude these.
        </p>
      </section>

      {/* Section 4: Provider scoreboard */}
      <section>
        <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">Provider scoreboard</p>
        <div className="bg-white border border-[#dad4cb] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wide text-[#5a6a72] bg-[#f4f1ed]">
              <tr>
                <th className="px-4 py-2 text-left">Provider</th>
                <th className="px-4 py-2 text-right">Routed</th>
                <th className="px-4 py-2 text-right">Enrolled</th>
                <th className="px-4 py-2 text-right">Conversion</th>
                <th className="px-4 py-2 text-right">Free left</th>
                <th className="px-4 py-2 text-right">Billable</th>
                <th className="px-4 py-2 text-right">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {billingRows
                .filter((r) => r.active)
                .map((r) => {
                  const meta = providerMeta.get(r.provider_id);
                  const flat = meta?.pricing_model === "per_enrolment_flat" && meta?.per_enrolment_fee !== null;
                  const providerRevenue = flat ? r.billable_count * Number(meta!.per_enrolment_fee) : null;
                  const totalEnrolled = r.confirmed_enrolled + r.presumed_enrolled;
                  return (
                    <tr key={r.provider_id} className="border-t border-[#dad4cb]">
                      <td className="px-4 py-3">
                        <Link
                          href={`/providers/${encodeURIComponent(r.provider_id)}`}
                          className="font-medium text-[#143643] hover:text-[#cd8b76]"
                        >
                          {r.company_name ?? r.provider_id}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-right font-bold">{r.total_routed}</td>
                      <td className="px-4 py-3 text-right">
                        <span className="font-bold text-emerald-700">{totalEnrolled}</span>
                        {r.presumed_enrolled > 0 ? (
                          <span className="text-[10px] text-[#5a6a72]">
                            {" "}
                            ({r.confirmed_enrolled} confirmed + {r.presumed_enrolled} presumed)
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-right font-bold">
                        {r.conversion_rate_pct === null ? "—" : `${r.conversion_rate_pct}%`}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={r.free_enrolments_remaining === 0 ? "font-bold text-[#cd8b76]" : ""}>
                          {r.free_enrolments_remaining}
                        </span>
                        <span className="text-[10px] text-[#5a6a72]"> / 3</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {r.billable_count > 0 ? (
                          <span className="font-bold text-[#cd8b76]">{r.billable_count}</span>
                        ) : (
                          <span className="text-[#5a6a72]">0</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-bold">
                        {providerRevenue === null ? <span className="text-[#5a6a72]">% of fee</span> : gbp(providerRevenue)}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
            <tfoot className="text-xs bg-[#f4f1ed] border-t border-[#dad4cb]">
              <tr>
                <td className="px-4 py-3 font-bold uppercase tracking-wide text-[#5a6a72] text-[10px]">Total</td>
                <td className="px-4 py-3 text-right font-bold">—</td>
                <td className="px-4 py-3 text-right font-bold text-emerald-700">
                  {billingRows.reduce((s, r) => s + r.confirmed_enrolled + r.presumed_enrolled, 0)}
                </td>
                <td className="px-4 py-3"></td>
                <td className="px-4 py-3 text-right font-bold">{totalFreeRemaining}</td>
                <td className="px-4 py-3 text-right font-bold text-[#cd8b76]">
                  {billingRows.reduce((s, r) => s + r.billable_count, 0)}
                </td>
                <td className="px-4 py-3 text-right font-bold">{gbp(revenuePotentialGBP)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* Section 5: Profit/loss */}
      {metaIngestionLive ? (
        <section>
          <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">
            Profit/loss ({PERIOD_LABEL[period].toLowerCase()})
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <MoneyTile
              label="Profit/loss"
              value={profitLossThisPeriod === null ? "—" : gbp(profitLossThisPeriod)}
              note="Revenue minus ad spend, this period"
            />
          </div>
        </section>
      ) : null}

      {/* Section 6: Needs your attention */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">Needs your attention</p>
          {totalAttention === 0 ? (
            <span className="text-xs text-emerald-700 font-bold">Inbox zero</span>
          ) : (
            <span className="text-xs text-[#5a6a72]">{totalAttention} items</span>
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <SmallTile
            label="AI suggestions"
            value={aiPending}
            note="Approve / reject"
            href="/actions"
            emphasis={aiPending > 0 ? "primary" : undefined}
          />
          <SmallTile
            label="Unrouted"
            value={unrouted}
            note="Qualified, awaiting routing"
            href="/leads?routed=no&dq=no"
            emphasis={unrouted > 0 ? "primary" : undefined}
          />
          <SmallTile
            label="Presumed enrolled"
            value={presumed}
            note="Awaiting confirmation"
            href="/actions"
            emphasis={presumed > 0 ? "warn" : undefined}
          />
          <SmallTile
            label="Disputed"
            value={disputed}
            note="Provider rebutted"
            href="/leads?stage=routed"
            emphasis={disputed > 0 ? "warn" : undefined}
          />
          <SmallTile
            label="Unresolved errors"
            value={errors}
            note="Webhook / sheet / DB"
            href="/errors"
            emphasis={errors > 0 ? "warn" : undefined}
          />
        </div>
      </section>
    </div>
  );
}

function PeriodPills({ active }: { active: Period }) {
  const periods: Period[] = ["2d", "7d", "30d", "lifetime"];
  return (
    <div className="flex flex-wrap gap-2">
      {periods.map((p) => {
        const isActive = p === active;
        const href = p === "7d" ? "/" : `/?period=${p}`;
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

function PaceTile({
  label,
  value,
  delta,
  href,
  theme,
}: {
  label: string;
  value: number | string;
  delta: { sign: "up" | "down" | "flat"; label: string } | null;
  href?: string;
  theme?: "good";
}) {
  const cls = theme === "good" ? "bg-white border-2 border-emerald-200" : "bg-white border border-[#dad4cb]";
  const valueCls = theme === "good" ? "text-emerald-700" : "text-[#11242e]";
  const deltaCls =
    delta?.sign === "up" ? "text-emerald-700" : delta?.sign === "down" ? "text-[#b3412e]" : "text-[#5a6a72]";
  const arrow = delta?.sign === "up" ? "↑" : delta?.sign === "down" ? "↓" : "→";
  const inner = (
    <>
      <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">{label}</p>
      <p className={`text-4xl font-extrabold mt-2 tracking-tight ${valueCls}`}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      {delta ? (
        <p className={`text-[10px] mt-2 ${deltaCls} font-semibold`}>
          {delta.sign !== "flat" ? `${arrow} ` : ""}
          {delta.label}
        </p>
      ) : null}
    </>
  );
  const wrapper = `${cls} rounded-xl p-6 shadow-[0_4px_12px_rgba(17,36,46,0.08)] block transition-all`;
  return href ? (
    <Link href={href} className={wrapper + " hover:shadow-[0_4px_12px_rgba(17,36,46,0.18)]"}>
      {inner}
    </Link>
  ) : (
    <div className={wrapper}>{inner}</div>
  );
}

function ConversionTile({
  label,
  value,
  note,
  theme,
}: {
  label: string;
  value: string;
  note?: string;
  theme?: "good";
}) {
  const cls = theme === "good" ? "bg-white border-2 border-emerald-200" : "bg-white border border-[#dad4cb]";
  const valueCls = theme === "good" ? "text-emerald-700" : "text-[#11242e]";
  return (
    <div className={`${cls} rounded-xl p-6 shadow-[0_4px_12px_rgba(17,36,46,0.08)]`}>
      <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">{label}</p>
      <p className={`text-5xl font-extrabold mt-2 tracking-tight ${valueCls}`}>{value}</p>
      {note ? <p className="text-[10px] text-[#5a6a72] mt-2">{note}</p> : null}
    </div>
  );
}

function MoneyTile({
  label,
  value,
  note,
  theme,
}: {
  label: string;
  value: string | number;
  note?: string;
  theme?: "good";
}) {
  const valueCls = theme === "good" ? "text-emerald-700" : "text-[#11242e]";
  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-6 shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
      <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">{label}</p>
      <p className={`text-3xl font-extrabold mt-2 tracking-tight ${valueCls}`}>{value}</p>
      {note ? <p className="text-[10px] text-[#5a6a72] mt-2">{note}</p> : null}
    </div>
  );
}

function SmallTile({
  label,
  value,
  note,
  href,
  emphasis,
}: {
  label: string;
  value: number | string;
  note?: string;
  href?: string;
  emphasis?: "primary" | "warn" | "good";
}) {
  const base = "block bg-white rounded-xl p-4 transition-all";
  const border =
    emphasis === "warn"
      ? "border-2 border-[#cd8b76] hover:shadow-[0_4px_12px_rgba(205,139,118,0.25)]"
      : emphasis === "good"
        ? "border border-emerald-200 hover:border-emerald-400 hover:shadow-[0_4px_12px_rgba(17,36,46,0.08)]"
        : emphasis === "primary"
          ? "border border-[#143643] hover:border-[#11242e] hover:shadow-[0_4px_12px_rgba(17,36,46,0.08)]"
          : "border border-[#dad4cb] hover:border-[#cd8b76]/60 hover:shadow-[0_4px_12px_rgba(17,36,46,0.08)]";
  const valueColor =
    emphasis === "warn" ? "text-[#cd8b76]" : emphasis === "good" ? "text-emerald-700" : "text-[#11242e]";
  const inner = (
    <>
      <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">{label}</p>
      <p className={`text-3xl font-extrabold mt-2 tracking-tight ${valueColor}`}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      {note ? <p className="text-[10px] text-[#5a6a72] mt-1">{note}</p> : null}
    </>
  );
  return href ? (
    <Link href={href} className={`${base} ${border}`}>
      {inner}
    </Link>
  ) : (
    <div className={`${base} ${border}`}>{inner}</div>
  );
}
