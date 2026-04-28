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

const NOW = () => new Date();
const DAYS_AGO = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

function distinctEmails(rows: Array<{ email: string | null }> | null | undefined): number {
  return new Set(
    (rows ?? [])
      .map((r) => r.email?.toLowerCase().trim() ?? "")
      .filter((e) => e.length > 0),
  ).size;
}

function delta(thisWeek: number, lastWeek: number): { sign: "up" | "down" | "flat"; abs: number; label: string } {
  if (thisWeek === lastWeek) return { sign: "flat", abs: 0, label: "no change" };
  const diff = thisWeek - lastWeek;
  return {
    sign: diff > 0 ? "up" : "down",
    abs: Math.abs(diff),
    label: lastWeek === 0 ? `from 0` : `${diff > 0 ? "+" : ""}${diff} vs last week`,
  };
}

function gbp(n: number | null): string {
  if (n === null) return "—";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(n);
}

export default async function AdminHomePage() {
  const supabase = await createClient();

  const week1Start = DAYS_AGO(7);
  const week2Start = DAYS_AGO(14);

  const [
    // Pace
    leadsThisWeekRes,
    leadsLastWeekRes,
    routedThisWeekRes,
    routedLastWeekRes,
    enrolThisWeekRes,
    enrolLastWeekRes,
    // Money & providers
    billingRes,
    providersRes,
    metaSpendThisWeekRes,
    metaSpendLastWeekRes,
    // Attention
    unroutedRes,
    presumedRes,
    disputedRes,
    errorsRes,
    // Used to surface "first billable date"
    presumedListRes,
  ] = await Promise.all([
    // Leads in: distinct emails of non-DQ submissions in window
    supabase.schema("leads").from("submissions").select("email")
      .eq("is_dq", false).is("archived_at", null).gte("submitted_at", week1Start),
    supabase.schema("leads").from("submissions").select("email")
      .eq("is_dq", false).is("archived_at", null).gte("submitted_at", week2Start).lt("submitted_at", week1Start),
    // Sent to providers: distinct emails of routed-in-window
    supabase.schema("leads").from("submissions").select("email")
      .not("primary_routed_to", "is", null).is("archived_at", null).gte("routed_at", week1Start),
    supabase.schema("leads").from("submissions").select("email")
      .not("primary_routed_to", "is", null).is("archived_at", null).gte("routed_at", week2Start).lt("routed_at", week1Start),
    // Enrolments confirmed (not presumed) in window
    supabase.schema("crm").from("enrolments").select("id", { count: "exact", head: true })
      .eq("status", "enrolled").gte("status_updated_at", week1Start),
    supabase.schema("crm").from("enrolments").select("id", { count: "exact", head: true })
      .eq("status", "enrolled").gte("status_updated_at", week2Start).lt("status_updated_at", week1Start),
    // Provider billing state
    supabase.schema("crm").from("vw_provider_billing_state")
      .select("provider_id, company_name, active, total_routed, confirmed_enrolled, presumed_enrolled, free_enrolments_remaining, billable_count, conversion_rate_pct")
      .order("total_routed", { ascending: false }),
    supabase.schema("crm").from("providers")
      .select("provider_id, company_name, per_enrolment_fee, pricing_model"),
    // Meta ad spend (placeholder until ingestion lands)
    supabase.schema("ads_switchable").from("meta_daily").select("spend").gte("date", week1Start.slice(0, 10)),
    supabase.schema("ads_switchable").from("meta_daily").select("spend").gte("date", week2Start.slice(0, 10)).lt("date", week1Start.slice(0, 10)),
    // Attention
    supabase.schema("leads").from("submissions").select("id", { count: "exact", head: true })
      .eq("is_dq", false).is("primary_routed_to", null).is("archived_at", null),
    supabase.schema("crm").from("enrolments").select("id", { count: "exact", head: true }).eq("status", "presumed_enrolled"),
    supabase.schema("crm").from("enrolments").select("id", { count: "exact", head: true }).not("disputed_at", "is", null),
    supabase.schema("leads").from("dead_letter").select("id", { count: "exact", head: true }).is("replayed_at", null),
    // Presumed enrolment dates: surface earliest auto-flip-to-billable date.
    // Per .claude/rules/business.md: presumed flips after 14d (status_updated_at + 14)
    // and 7-day dispute window means actually-billable on +21 days.
    supabase.schema("crm").from("enrolments").select("id, status_updated_at, provider_id")
      .eq("status", "presumed_enrolled").order("status_updated_at", { ascending: true }).limit(1),
  ]);

  const leadsThis = distinctEmails(leadsThisWeekRes.data as Array<{ email: string | null }>);
  const leadsLast = distinctEmails(leadsLastWeekRes.data as Array<{ email: string | null }>);
  const routedThis = distinctEmails(routedThisWeekRes.data as Array<{ email: string | null }>);
  const routedLast = distinctEmails(routedLastWeekRes.data as Array<{ email: string | null }>);
  const enrolThis = enrolThisWeekRes.count ?? 0;
  const enrolLast = enrolLastWeekRes.count ?? 0;

  const billingRows = (billingRes.data ?? []) as ProviderBillingRow[];
  const providers = (providersRes.data ?? []) as ProviderRow[];
  const providerMeta = new Map(providers.map((p) => [p.provider_id, p]));

  // Revenue earned: sum of billable_count × per_enrolment_fee per provider.
  // Pilot rule (business.md): first 3 enrolments per provider are free; remainder
  // are billable. EMS + WYK on per_enrolment_flat = £150. CD on per_enrolment_percent
  // (course-fee dependent, fee is null in the providers table; we surface billable
  // count separately and treat revenue as "—" for percent-priced providers).
  let revenueEarnedGBP = 0;
  let revenueIncomplete = false;
  for (const r of billingRows) {
    const meta = providerMeta.get(r.provider_id);
    if (!meta) continue;
    if (meta.pricing_model === "per_enrolment_flat" && meta.per_enrolment_fee !== null) {
      revenueEarnedGBP += r.billable_count * Number(meta.per_enrolment_fee);
    } else if (meta.pricing_model === "per_enrolment_percent" && r.billable_count > 0) {
      revenueIncomplete = true;
    }
  }

  // Meta ad spend (placeholder until ingestion lands)
  const metaSpendThisRows = (metaSpendThisWeekRes.data ?? []) as Array<{ spend: number | null }>;
  const metaSpendLastRows = (metaSpendLastWeekRes.data ?? []) as Array<{ spend: number | null }>;
  const metaSpendThis = metaSpendThisRows.reduce((s, r) => s + Number(r.spend ?? 0), 0);
  const metaSpendLast = metaSpendLastRows.reduce((s, r) => s + Number(r.spend ?? 0), 0);
  const metaIngestionLive = metaSpendThisRows.length > 0 || metaSpendLastRows.length > 0;
  const cplThisWeek = metaIngestionLive && leadsThis > 0 ? metaSpendThis / leadsThis : null;
  const profitLossThisWeek = metaIngestionLive ? -metaSpendThis : null; // revenue lifetime, not weekly; profit/loss strictly weekly cash-out for pilot

  const totalFreeRemaining = billingRows.reduce((s, r) => s + (r.free_enrolments_remaining ?? 0), 0);
  const totalBillable = billingRows.reduce((s, r) => s + (r.billable_count ?? 0), 0);

  const unrouted = unroutedRes.count ?? 0;
  const presumed = presumedRes.count ?? 0;
  const disputed = disputedRes.count ?? 0;
  const errors = errorsRes.count ?? 0;
  const totalAttention = unrouted + presumed + disputed + errors;

  // Earliest presumed -> billable date (presumed status_updated_at + 21 days)
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
          { schema: "leads", table: "dead_letter" },
        ]}
      />
      <PageHeader
        eyebrow="Overview"
        title="Business health"
        subtitle={<span>Snapshot of where the business stands. This week vs last week, with money on the right.</span>}
      />

      {/* Section 1: Pace this week */}
      <section>
        <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">Pace (last 7 days)</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <PaceTile label="Leads in" value={leadsThis} delta={delta(leadsThis, leadsLast)} href="/leads?dq=no" />
          <PaceTile label="Sent to providers" value={routedThis} delta={delta(routedThis, routedLast)} href="/leads?routed=yes" />
          <PaceTile label="Enrolments confirmed" value={enrolThis} delta={delta(enrolThis, enrolLast)} href="/providers" theme="good" />
          <PaceTile
            label="Meta ad spend"
            value={metaIngestionLive ? gbp(metaSpendThis) : "—"}
            delta={metaIngestionLive ? deltaCurrency(metaSpendThis, metaSpendLast) : { sign: "flat", abs: 0, label: "Awaiting Meta ingestion" }}
            href={metaIngestionLive ? undefined : undefined}
          />
        </div>
      </section>

      {/* Section 2: Money */}
      <section>
        <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">Money</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MoneyTile
            label="Cost per lead"
            value={cplThisWeek === null ? "—" : gbp(cplThisWeek)}
            note={metaIngestionLive ? "Meta spend ÷ leads, this week" : "Awaiting Meta ingestion"}
          />
          <MoneyTile
            label="Revenue earned"
            value={gbp(revenueEarnedGBP)}
            note={revenueIncomplete ? "Plus % of CD enrolments (fee not yet set)" : "Lifetime, billable enrolments × fee"}
            theme="good"
          />
          <MoneyTile
            label="Profit/loss this week"
            value={profitLossThisWeek === null ? "—" : gbp(profitLossThisWeek)}
            note={metaIngestionLive ? "Revenue this week minus ad spend" : "Awaiting Meta ingestion"}
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
      </section>

      {/* Section 3: Provider scoreboard */}
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
              {billingRows.filter((r) => r.active).map((r) => {
                const meta = providerMeta.get(r.provider_id);
                const flat = meta?.pricing_model === "per_enrolment_flat" && meta?.per_enrolment_fee !== null;
                const providerRevenue = flat ? r.billable_count * Number(meta!.per_enrolment_fee) : null;
                const totalEnrolled = r.confirmed_enrolled + r.presumed_enrolled;
                return (
                  <tr key={r.provider_id} className="border-t border-[#dad4cb]">
                    <td className="px-4 py-3">
                      <Link href={`/providers/${encodeURIComponent(r.provider_id)}`} className="font-medium text-[#143643] hover:text-[#cd8b76]">
                        {r.company_name ?? r.provider_id}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right font-bold">{r.total_routed}</td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-bold text-emerald-700">{totalEnrolled}</span>
                      {r.presumed_enrolled > 0 ? (
                        <span className="text-[10px] text-[#5a6a72]"> ({r.confirmed_enrolled} confirmed + {r.presumed_enrolled} presumed)</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right font-bold">{r.conversion_rate_pct === null ? "—" : `${r.conversion_rate_pct}%`}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={r.free_enrolments_remaining === 0 ? "font-bold text-[#cd8b76]" : ""}>{r.free_enrolments_remaining}</span>
                      <span className="text-[10px] text-[#5a6a72]"> / 3</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.billable_count > 0 ? <span className="font-bold text-[#cd8b76]">{r.billable_count}</span> : <span className="text-[#5a6a72]">0</span>}
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
                <td className="px-4 py-3 text-right font-bold text-emerald-700">{billingRows.reduce((s, r) => s + r.confirmed_enrolled + r.presumed_enrolled, 0)}</td>
                <td className="px-4 py-3"></td>
                <td className="px-4 py-3 text-right font-bold">{totalFreeRemaining}</td>
                <td className="px-4 py-3 text-right font-bold text-[#cd8b76]">{totalBillable}</td>
                <td className="px-4 py-3 text-right font-bold">{gbp(revenueEarnedGBP)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* Section 4: Needs your attention */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">Needs your attention</p>
          {totalAttention === 0 ? (
            <span className="text-xs text-emerald-700 font-bold">Inbox zero</span>
          ) : (
            <span className="text-xs text-[#5a6a72]">{totalAttention} items</span>
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <SmallTile label="Unrouted" value={unrouted} note="Qualified, awaiting routing" href="/leads?routed=no&dq=no" emphasis={unrouted > 0 ? "primary" : undefined} />
          <SmallTile label="Presumed enrolled" value={presumed} note="Awaiting confirmation" href="/actions" emphasis={presumed > 0 ? "warn" : undefined} />
          <SmallTile label="Disputed" value={disputed} note="Provider rebutted" href="/leads?routed=yes" emphasis={disputed > 0 ? "warn" : undefined} />
          <SmallTile label="Unresolved errors" value={errors} note="Webhook / sheet / DB" href="/errors" emphasis={errors > 0 ? "warn" : undefined} />
        </div>
      </section>
    </div>
  );
}

function deltaCurrency(thisWeek: number, lastWeek: number): { sign: "up" | "down" | "flat"; abs: number; label: string } {
  if (thisWeek === lastWeek) return { sign: "flat", abs: 0, label: "no change" };
  const diff = thisWeek - lastWeek;
  return {
    sign: diff > 0 ? "up" : "down",
    abs: Math.abs(diff),
    label: lastWeek === 0 ? `from £0` : `${diff > 0 ? "+" : ""}${gbp(diff)} vs last week`,
  };
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
  delta: { sign: "up" | "down" | "flat"; abs: number; label: string };
  href?: string;
  theme?: "good";
}) {
  const cls = theme === "good" ? "bg-white border-2 border-emerald-200" : "bg-white border border-[#dad4cb]";
  const valueCls = theme === "good" ? "text-emerald-700" : "text-[#11242e]";
  const deltaCls =
    delta.sign === "up" ? "text-emerald-700" : delta.sign === "down" ? "text-[#b3412e]" : "text-[#5a6a72]";
  const arrow = delta.sign === "up" ? "↑" : delta.sign === "down" ? "↓" : "→";
  const inner = (
    <>
      <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">{label}</p>
      <p className={`text-4xl font-extrabold mt-2 tracking-tight ${valueCls}`}>{typeof value === "number" ? value.toLocaleString() : value}</p>
      <p className={`text-[10px] mt-2 ${deltaCls} font-semibold`}>
        {delta.sign !== "flat" ? `${arrow} ` : ""}
        {delta.label}
      </p>
    </>
  );
  const wrapper = `${cls} rounded-xl p-6 shadow-[0_4px_12px_rgba(17,36,46,0.08)] block transition-all`;
  return href ? (
    <Link href={href} className={wrapper + " hover:shadow-[0_4px_12px_rgba(17,36,46,0.18)]"}>{inner}</Link>
  ) : (
    <div className={wrapper}>{inner}</div>
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
    emphasis === "warn" ? "border-2 border-[#cd8b76] hover:shadow-[0_4px_12px_rgba(205,139,118,0.25)]" :
    emphasis === "good" ? "border border-emerald-200 hover:border-emerald-400 hover:shadow-[0_4px_12px_rgba(17,36,46,0.08)]" :
    emphasis === "primary" ? "border border-[#143643] hover:border-[#11242e] hover:shadow-[0_4px_12px_rgba(17,36,46,0.08)]" :
    "border border-[#dad4cb] hover:border-[#cd8b76]/60 hover:shadow-[0_4px_12px_rgba(17,36,46,0.08)]";
  const valueColor =
    emphasis === "warn" ? "text-[#cd8b76]" :
    emphasis === "good" ? "text-emerald-700" :
    "text-[#11242e]";
  const inner = (
    <>
      <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">{label}</p>
      <p className={`text-3xl font-extrabold mt-2 tracking-tight ${valueColor}`}>{typeof value === "number" ? value.toLocaleString() : value}</p>
      {note ? <p className="text-[10px] text-[#5a6a72] mt-1">{note}</p> : null}
    </>
  );
  return href ? (
    <Link href={href} className={`${base} ${border}`}>{inner}</Link>
  ) : (
    <div className={`${base} ${border}`}>{inner}</div>
  );
}
