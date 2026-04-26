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

export default async function AdminHomePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const period = normalisePeriod(sp.period);
  const cutoff = periodCutoff(period);

  const supabase = await createClient();

  // Build period-scoped queries. Lead-based tiles filter on submitted_at,
  // enrolment-based tiles filter on status_updated_at, providers + errors
  // are point-in-time (always current).

  // Helper to apply the period filter conditionally.
  const subPeriod = <T extends { gte: (col: string, val: string) => T }>(q: T): T =>
    cutoff ? q.gte("submitted_at", cutoff) : q;
  const enrolPeriod = <T extends { gte: (col: string, val: string) => T }>(q: T): T =>
    cutoff ? q.gte("status_updated_at", cutoff) : q;

  const [
    unroutedRes,
    routedActiveRes,
    waitlistRes,
    presumedRes,
    enrolledRes,
    notEnrolledRes,
    disputedRes,
    errorsRes,
    providersRes,
    // Macro totals — single big-picture numbers. Period-aware via submitted_at.
    qualifiedUniqueRes,
    waitlistUniqueRes,
    formSubmissionsRes,
  ] = await Promise.all([
    // Unrouted (qualified, awaiting decision)
    subPeriod(
      supabase
        .schema("leads")
        .from("submissions")
        .select("id", { count: "exact", head: true })
        .eq("is_dq", false)
        .is("primary_routed_to", null)
        .is("archived_at", null),
    ),
    // Routed (active) — routed + not archived. Subtract terminal-outcome rows
    // from this count via a follow-up query, OR just count crm.enrolments in
    // open/contacted state. Going with the latter for simplicity.
    enrolPeriod(
      supabase
        .schema("crm")
        .from("enrolments")
        .select("id", { count: "exact", head: true })
        .in("status", ["open", "contacted"]),
    ),
    // Waitlist (DQ leads, not archived, unique people only — child re-applications
    // and waitlist-enrichment children are linked to parents via parent_submission_id
    // and excluded from the count to avoid double-counting).
    subPeriod(
      supabase
        .schema("leads")
        .from("submissions")
        .select("id", { count: "exact", head: true })
        .eq("is_dq", true)
        .is("archived_at", null)
        .is("parent_submission_id", null),
    ),
    // Presumed enrolled (auto-flipped)
    enrolPeriod(
      supabase
        .schema("crm")
        .from("enrolments")
        .select("id", { count: "exact", head: true })
        .eq("status", "presumed_enrolled"),
    ),
    // Confirmed enrolled (billable)
    enrolPeriod(
      supabase
        .schema("crm")
        .from("enrolments")
        .select("id", { count: "exact", head: true })
        .eq("status", "enrolled"),
    ),
    // Not enrolled (closed without billing)
    enrolPeriod(
      supabase
        .schema("crm")
        .from("enrolments")
        .select("id", { count: "exact", head: true })
        .eq("status", "not_enrolled"),
    ),
    // Disputed
    enrolPeriod(
      supabase
        .schema("crm")
        .from("enrolments")
        .select("id", { count: "exact", head: true })
        .eq("status", "disputed"),
    ),
    // Unresolved errors (point-in-time)
    supabase
      .schema("leads")
      .from("dead_letter")
      .select("id", { count: "exact", head: true })
      .is("replayed_at", null),
    // Active providers (point-in-time)
    supabase.schema("crm").from("providers").select("provider_id", { count: "exact", head: true }).eq("active", true),

    // Macro totals — these are the big-picture numbers Charlotte looks at first.
    // Each is "unique people" (parent_submission_id IS NULL) and excludes
    // archived test/cleanup rows. Period-aware via submitted_at.

    // Total qualified unique leads — unique people, not DQ'd.
    subPeriod(
      supabase
        .schema("leads")
        .from("submissions")
        .select("id", { count: "exact", head: true })
        .eq("is_dq", false)
        .is("parent_submission_id", null)
        .is("archived_at", null),
    ),
    // Total unique waitlist leads — unique people, DQ'd.
    subPeriod(
      supabase
        .schema("leads")
        .from("submissions")
        .select("id", { count: "exact", head: true })
        .eq("is_dq", true)
        .is("parent_submission_id", null)
        .is("archived_at", null),
    ),
    // Total form submissions — every form fill (including children), excluding
    // archived test rows. Useful for ad performance / volume tracking.
    subPeriod(
      supabase
        .schema("leads")
        .from("submissions")
        .select("id", { count: "exact", head: true })
        .is("archived_at", null),
    ),
  ]);

  const tiles: Array<{ label: string; value: number; href: string; emphasis?: "primary" | "warn" | "good" }> = [
    {
      label: "Unrouted",
      value: unroutedRes.count ?? 0,
      href: "/leads?routed=no&dq=no",
      emphasis: "primary",
    },
    {
      label: "Routed (active)",
      value: routedActiveRes.count ?? 0,
      href: "/leads?routed=yes",
    },
    {
      label: "Waitlist",
      value: waitlistRes.count ?? 0,
      href: "/leads?dq=yes",
    },
    {
      label: "Presumed enrolled",
      value: presumedRes.count ?? 0,
      href: "/actions",
      emphasis: presumedRes.count && presumedRes.count > 0 ? "warn" : undefined,
    },
    {
      label: "Confirmed enrolled",
      value: enrolledRes.count ?? 0,
      href: "/leads?routed=yes",
      emphasis: "good",
    },
    {
      label: "Not enrolled",
      value: notEnrolledRes.count ?? 0,
      href: "/leads?routed=yes",
    },
    {
      label: "Disputed",
      value: disputedRes.count ?? 0,
      href: "/leads?routed=yes",
      emphasis: disputedRes.count && disputedRes.count > 0 ? "warn" : undefined,
    },
    {
      label: "Unresolved errors",
      value: errorsRes.count ?? 0,
      href: "/errors",
      emphasis: errorsRes.count && errorsRes.count > 0 ? "warn" : undefined,
    },
    {
      label: "Active providers",
      value: providersRes.count ?? 0,
      href: "/providers",
    },
  ];

  return (
    <div className="max-w-6xl">
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
            Lifecycle counts. Period applies to lead and enrolment tiles; errors and providers are point-in-time.
          </span>
        }
      />

      {/* Period selector */}
      <div className="flex flex-wrap gap-2 mb-6">
        {(["week", "month", "all"] as Period[]).map((p) => {
          const active = period === p;
          const href = p === "week" ? "/" : `/?period=${p}`;
          return (
            <Link
              key={p}
              href={href}
              className={
                active
                  ? "px-4 h-9 inline-flex items-center text-[11px] font-bold uppercase tracking-[0.08em] rounded-full bg-[#cd8b76] text-white border border-[#cd8b76]"
                  : "px-4 h-9 inline-flex items-center text-[11px] font-bold uppercase tracking-[0.08em] rounded-full bg-white text-[#143643] border border-[#dad4cb] hover:border-[#cd8b76]/60"
              }
            >
              {PERIOD_LABEL[p]}
            </Link>
          );
        })}
      </div>

      {/* Macro totals — big-picture numbers above the lifecycle breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-[#143643] text-white rounded-xl p-6 shadow-[0_4px_12px_rgba(17,36,46,0.15)]">
          <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#cd8b76]">
            Total qualified unique leads
          </p>
          <p className="text-4xl font-extrabold mt-2 tracking-tight">
            {(qualifiedUniqueRes.count ?? 0).toLocaleString()}
          </p>
          <p className="text-[10px] text-white/60 mt-2">
            Unique people who passed DQ. Children + waitlist excluded.
          </p>
        </div>
        <div className="bg-white border-2 border-[#143643] rounded-xl p-6 shadow-[0_4px_12px_rgba(17,36,46,0.08)]">
          <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">
            Total unique waitlist leads
          </p>
          <p className="text-4xl font-extrabold mt-2 tracking-tight text-[#11242e]">
            {(waitlistUniqueRes.count ?? 0).toLocaleString()}
          </p>
          <p className="text-[10px] text-[#5a6a72] mt-2">
            Unique people DQ'd onto waitlist.
          </p>
        </div>
        <div className="bg-white border border-[#dad4cb] rounded-xl p-6">
          <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">
            Total form submissions
          </p>
          <p className="text-4xl font-extrabold mt-2 tracking-tight text-[#11242e]">
            {(formSubmissionsRes.count ?? 0).toLocaleString()}
          </p>
          <p className="text-[10px] text-[#5a6a72] mt-2">
            Every form fill (incl. re-applications + enrichments). Archived test rows excluded.
          </p>
        </div>
      </div>

      <h2 className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3 mt-8">
        Lifecycle breakdown
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-4 mb-8">
        {tiles.map((t) => (
          <Link
            key={t.label}
            href={t.href}
            className={tileClass(t.emphasis)}
          >
            <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">
              {t.label}
            </p>
            <p className={valueClass(t.emphasis)}>
              {t.value.toLocaleString()}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}

function tileClass(emphasis?: "primary" | "warn" | "good"): string {
  const base = "block bg-white rounded-xl p-5 transition-all";
  if (emphasis === "warn") {
    return `${base} border-2 border-[#cd8b76] hover:shadow-[0_4px_12px_rgba(205,139,118,0.25)]`;
  }
  if (emphasis === "good") {
    return `${base} border border-emerald-200 hover:border-emerald-400 hover:shadow-[0_4px_12px_rgba(17,36,46,0.08)]`;
  }
  if (emphasis === "primary") {
    return `${base} border border-[#143643] hover:border-[#11242e] hover:shadow-[0_4px_12px_rgba(17,36,46,0.08)]`;
  }
  return `${base} border border-[#dad4cb] hover:border-[#cd8b76]/60 hover:shadow-[0_4px_12px_rgba(17,36,46,0.08)]`;
}

function valueClass(emphasis?: "primary" | "warn" | "good"): string {
  const base = "text-3xl font-extrabold mt-2 tracking-tight";
  if (emphasis === "warn") return `${base} text-[#cd8b76]`;
  if (emphasis === "good") return `${base} text-emerald-700`;
  return `${base} text-[#11242e]`;
}
