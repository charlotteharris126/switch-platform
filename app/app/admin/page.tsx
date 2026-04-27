import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { RealtimeRefresh } from "@/components/realtime-refresh";

type Period = "week" | "month" | "all";

interface SearchParams {
  period?: string;
}

const PERIOD_LABEL: Record<Period, string> = {
  week: "Last 7 days",
  month: "Last 30 days",
  all: "All time",
};

function periodCutoff(period: Period): string | null {
  if (period === "all") return null;
  const days = period === "week" ? 7 : 30;
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

function normalisePeriod(value: string | undefined): Period {
  if (value === "week" || value === "month" || value === "all") return value;
  return "week";
}

interface ProviderBillingRow {
  provider_id: string;
  active: boolean;
  total_routed: number;
  confirmed_enrolled: number;
  presumed_enrolled: number;
  billable_or_pending_count: number;
  free_enrolments_remaining: number;
  billable_count: number;
  conversion_rate_pct: number | null;
}

export default async function AdminHomePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const period = normalisePeriod(sp.period);
  const cutoff = periodCutoff(period);

  const supabase = await createClient();

  // Period filter helper
  const subPeriod = <T extends { gte: (col: string, val: string) => T }>(q: T): T =>
    cutoff ? q.gte("submitted_at", cutoff) : q;
  const enrolPeriod = <T extends { gte: (col: string, val: string) => T }>(q: T): T =>
    cutoff ? q.gte("status_updated_at", cutoff) : q;

  const [
    // Lifetime business-health numbers
    qualifiedUniqueRes,
    totalRoutedRes,
    totalEnrolmentsRes,
    activeProvidersRes,
    // Per-provider billing state (derives free / billable from real enrolments)
    billingStateRes,
    // Period-aware lifecycle
    weekQualifiedRes,
    weekEnrolmentsRes,
    openRes,
    cannotReachRes,
    lostRes,
    waitlistUniqueRes,
    // Always-visible attention surfaces
    unroutedRes,
    presumedRes,
    disputedRes,
    errorsRes,
  ] = await Promise.all([
    // ── Lifetime ───────────────────────────────────────────────────────────
    // Qualified unique leads (lifetime, not DQ'd, not children, not archived)
    supabase
      .schema("leads")
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("is_dq", false)
      .is("parent_submission_id", null)
      .is("archived_at", null),
    // Routed unique people: distinct emails across all routed live submissions
    // (parents + children, excluding archived). One person submitting twice
    // counts once. The raw routing_log COUNT(*) inflates this number; "unique
    // people" is the business KPI.
    supabase
      .schema("leads")
      .from("submissions")
      .select("email")
      .not("primary_routed_to", "is", null)
      .is("archived_at", null),
    // Total enrolments (confirmed + presumed) — counts toward conversion + billing
    supabase
      .schema("crm")
      .from("enrolments")
      .select("id", { count: "exact", head: true })
      .in("status", ["enrolled", "presumed_enrolled"]),
    // Active providers
    supabase
      .schema("crm")
      .from("providers")
      .select("provider_id", { count: "exact", head: true })
      .eq("active", true),
    // Per-provider billing state via the derived view
    supabase
      .schema("crm")
      .from("vw_provider_billing_state")
      .select("provider_id, active, total_routed, confirmed_enrolled, presumed_enrolled, billable_or_pending_count, free_enrolments_remaining, billable_count, conversion_rate_pct")
      .eq("active", true),

    // ── Period-aware ───────────────────────────────────────────────────────
    subPeriod(
      supabase
        .schema("leads")
        .from("submissions")
        .select("id", { count: "exact", head: true })
        .eq("is_dq", false)
        .is("parent_submission_id", null)
        .is("archived_at", null),
    ),
    enrolPeriod(
      supabase
        .schema("crm")
        .from("enrolments")
        .select("id", { count: "exact", head: true })
        .in("status", ["enrolled", "presumed_enrolled"]),
    ),
    enrolPeriod(
      supabase
        .schema("crm")
        .from("enrolments")
        .select("id", { count: "exact", head: true })
        .eq("status", "open"),
    ),
    enrolPeriod(
      supabase
        .schema("crm")
        .from("enrolments")
        .select("id", { count: "exact", head: true })
        .eq("status", "cannot_reach"),
    ),
    enrolPeriod(
      supabase
        .schema("crm")
        .from("enrolments")
        .select("id", { count: "exact", head: true })
        .eq("status", "lost"),
    ),
    subPeriod(
      supabase
        .schema("leads")
        .from("submissions")
        .select("id", { count: "exact", head: true })
        .eq("is_dq", true)
        .is("archived_at", null)
        .is("parent_submission_id", null),
    ),

    // ── Attention surfaces (point-in-time, ignore period) ──────────────────
    supabase
      .schema("leads")
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("is_dq", false)
      .is("primary_routed_to", null)
      .is("archived_at", null),
    supabase
      .schema("crm")
      .from("enrolments")
      .select("id", { count: "exact", head: true })
      .eq("status", "presumed_enrolled"),
    supabase
      .schema("crm")
      .from("enrolments")
      .select("id", { count: "exact", head: true })
      .not("disputed_at", "is", null),
    supabase
      .schema("leads")
      .from("dead_letter")
      .select("id", { count: "exact", head: true })
      .is("replayed_at", null),
  ]);

  const billingRows = (billingStateRes.data ?? []) as ProviderBillingRow[];

  const routedEmails = (totalRoutedRes.data ?? []) as Array<{ email: string | null }>;
  const totalRouted = new Set(
    routedEmails
      .map((r) => r.email?.toLowerCase().trim() ?? "")
      .filter((e) => e.length > 0)
  ).size;
  const totalEnrolments = totalEnrolmentsRes.count ?? 0;
  // Two conversion rates: confirmed-only and including presumed.
  const confirmedEnrolled = billingRows.reduce((s, r) => s + (r.confirmed_enrolled ?? 0), 0);
  const conversionConfirmedPct = totalRouted > 0 ? Math.round((confirmedEnrolled / totalRouted) * 1000) / 10 : null;
  const conversionPotentialPct = totalRouted > 0 ? Math.round((totalEnrolments / totalRouted) * 1000) / 10 : null;

  // Pilot stats: free remaining + billable across providers
  const totalFreeRemaining = billingRows.reduce((sum, r) => sum + (r.free_enrolments_remaining ?? 0), 0);
  const totalBillable = billingRows.reduce((sum, r) => sum + (r.billable_count ?? 0), 0);

  // Things that need attention
  const unrouted = unroutedRes.count ?? 0;
  const presumed = presumedRes.count ?? 0;
  const disputed = disputedRes.count ?? 0;
  const errors = errorsRes.count ?? 0;
  const totalAttention = unrouted + presumed + disputed + errors;

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
        title="Where the business is"
        subtitle={
          <span>
            Top tiles are lifetime totals. The lifecycle breakdown below applies the period selector.
          </span>
        }
      />

      {/* ─── Headline numbers (lifetime, big) ─────────────────────────────── */}
      <section>
        <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">Business health (lifetime, unique people)</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Headline
            label="Qualified leads"
            value={qualifiedUniqueRes.count ?? 0}
            note="Unique people, not DQ'd"
            href="/leads?dq=no"
            theme="dark"
          />
          <Headline
            label="Routed"
            value={totalRouted}
            note="Unique people sent to a provider"
            href="/leads?routed=yes"
          />
          <Headline
            label="Enrolments"
            value={totalEnrolments}
            note={`${confirmedEnrolled} confirmed + ${totalEnrolments - confirmedEnrolled} presumed`}
            href="/providers"
            theme="good"
          />
          <Headline
            label="Conversion"
            value={conversionPotentialPct === null ? "—" : `${conversionPotentialPct}%`}
            note={
              conversionConfirmedPct === null
                ? "Enrolments ÷ routed"
                : `Confirmed only: ${conversionConfirmedPct}%`
            }
          />
        </div>
      </section>

      {/* ─── Pilot billing state ──────────────────────────────────────────── */}
      <section>
        <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">Pilot billing</p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <SmallTile
            label="Active providers"
            value={activeProvidersRes.count ?? 0}
            href="/providers"
          />
          <SmallTile
            label="Pilot free remaining"
            value={totalFreeRemaining}
            note={`Across ${billingRows.length} provider${billingRows.length === 1 ? "" : "s"}`}
            href="/providers"
          />
          <SmallTile
            label="Billable enrolments"
            value={totalBillable}
            note="Past 3-free per provider"
            href="/providers"
            emphasis={totalBillable > 0 ? "good" : undefined}
          />
        </div>
      </section>

      {/* ─── Things that need attention ───────────────────────────────────── */}
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
            href="/leads?routed=yes"
            emphasis={disputed > 0 ? "warn" : undefined}
          />
          <SmallTile
            label="Unresolved errors"
            value={errors}
            note="Webhook / sheet failures"
            href="/errors"
            emphasis={errors > 0 ? "warn" : undefined}
          />
        </div>
      </section>

      {/* ─── Period-aware lifecycle breakdown ─────────────────────────────── */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">Lifecycle breakdown</p>
          <div className="flex flex-wrap gap-2">
            {(["week", "month", "all"] as Period[]).map((p) => {
              const active = period === p;
              const href = p === "week" ? "/" : `/?period=${p}`;
              return (
                <Link
                  key={p}
                  href={href}
                  className={
                    active
                      ? "px-3 h-7 inline-flex items-center text-[10px] font-bold uppercase tracking-[0.08em] rounded-full bg-[#cd8b76] text-white border border-[#cd8b76]"
                      : "px-3 h-7 inline-flex items-center text-[10px] font-bold uppercase tracking-[0.08em] rounded-full bg-white text-[#143643] border border-[#dad4cb] hover:border-[#cd8b76]/60"
                  }
                >
                  {PERIOD_LABEL[p]}
                </Link>
              );
            })}
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-4">
          <SmallTile label="Qualified" value={weekQualifiedRes.count ?? 0} href="/leads?dq=no" />
          <SmallTile label="Enrolments" value={weekEnrolmentsRes.count ?? 0} emphasis="good" href="/providers" />
          <SmallTile label="Awaiting outcome" value={openRes.count ?? 0} note="Status: open" href="/actions" />
          <SmallTile label="Cannot reach" value={cannotReachRes.count ?? 0} emphasis={(cannotReachRes.count ?? 0) > 0 ? "warn" : undefined} />
          <SmallTile label="Lost" value={lostRes.count ?? 0} />
          <SmallTile label="Waitlist (DQ)" value={waitlistUniqueRes.count ?? 0} href="/leads?dq=yes" />
        </div>
      </section>

    </div>
  );
}

/** Big headline tile — used for top-level lifetime numbers. */
function Headline({
  label,
  value,
  note,
  href,
  theme,
}: {
  label: string;
  value: number | string;
  note?: string;
  href?: string;
  theme?: "dark" | "good";
}) {
  const cls =
    theme === "dark"
      ? "bg-[#143643] text-white"
      : theme === "good"
        ? "bg-white border-2 border-emerald-200"
        : "bg-white border border-[#dad4cb]";
  const labelCls = theme === "dark" ? "text-[#cd8b76]" : "text-[#5a6a72]";
  const noteCls = theme === "dark" ? "text-white/60" : "text-[#5a6a72]";
  const valueCls =
    theme === "dark" ? "text-white" :
    theme === "good" ? "text-emerald-700" :
    "text-[#11242e]";
  const inner = (
    <>
      <p className={`text-[10px] font-bold uppercase tracking-[2px] ${labelCls}`}>{label}</p>
      <p className={`text-4xl font-extrabold mt-2 tracking-tight ${valueCls}`}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      {note ? <p className={`text-[10px] mt-2 ${noteCls}`}>{note}</p> : null}
    </>
  );
  const wrapper = `${cls} rounded-xl p-6 shadow-[0_4px_12px_rgba(17,36,46,0.08)] block transition-all`;
  return href ? (
    <Link href={href} className={wrapper + " hover:shadow-[0_4px_12px_rgba(17,36,46,0.18)]"}>{inner}</Link>
  ) : (
    <div className={wrapper}>{inner}</div>
  );
}

/** Smaller tile — used for second-tier info and lifecycle breakdown. */
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
      <p className={`text-3xl font-extrabold mt-2 tracking-tight ${valueColor}`}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      {note ? <p className="text-[10px] text-[#5a6a72] mt-1">{note}</p> : null}
    </>
  );
  return href ? (
    <Link href={href} className={`${base} ${border}`}>{inner}</Link>
  ) : (
    <div className={`${base} ${border}`}>{inner}</div>
  );
}
