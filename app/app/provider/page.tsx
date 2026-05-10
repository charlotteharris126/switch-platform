// /provider — gated home for authenticated provider users.
//
// At-a-glance dashboard:
//   - Hero strip: enrolments this month + month-on-month delta + estimated
//     fees-this-month if we have a per-enrolment fee on file
//   - Action queue: only renders cards that have non-zero counts (callbacks /
//     fastrack ready / stale opens) — silent when nothing's urgent
//   - Pipeline funnel: visual breakdown of where leads sit, segments
//     proportional to count
//   - Recent activity: last 5 routed leads with duration + status
//
// All lead reads run as the authenticated role so RLS from migration 0096
// scopes everything to this provider automatically. Provider context (the
// pu + provider rows) loads via the admin client because crm.provider_users
// has admin-gated RLS that the authenticated session doesn't satisfy on
// self-lookup.

import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ProviderShell } from "./provider-shell";
import { DurationTimer } from "./duration-timer";
import { STATUS_LABEL, type LeadStatus } from "@/lib/lead-status";

interface ProviderUserRow {
  id: number;
  provider_id: string;
  contact_email: string;
  display_name: string | null;
  role: string;
  enrolled_at: string | null;
  status: string;
}

interface ProviderRow {
  company_name: string;
  per_enrolment_fee: number | null;
  free_enrolments_remaining: number | null;
}

interface EnrolmentCountRow {
  status: string;
  status_updated_at: string;
  callback_requested_at: string | null;
}

interface RecentLeadRow {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  course_id: string | null;
  routed_at: string | null;
}

interface RecentEnrolmentRow {
  submission_id: number;
  status: string;
  status_updated_at: string;
}

interface FastrackParentRow {
  parent_submission_id: number;
}

interface RoutedSubIdRow {
  id: number;
}

const STATUS_TONE: Record<LeadStatus, string> = {
  open: "bg-slate-100 text-slate-700 border-slate-200",
  attempt_1_no_answer: "bg-amber-50 text-amber-700 border-amber-200",
  attempt_2_no_answer: "bg-amber-100 text-amber-800 border-amber-300",
  attempt_3_no_answer: "bg-orange-100 text-orange-800 border-orange-300",
  enrolment_meeting_booked: "bg-blue-50 text-blue-700 border-blue-200",
  enrolled: "bg-emerald-50 text-emerald-700 border-emerald-200",
  presumed_enrolled: "bg-emerald-50 text-emerald-700 border-emerald-200",
  lost: "bg-rose-50 text-rose-700 border-rose-200",
  cannot_reach: "bg-rose-50 text-rose-700 border-rose-200",
};

export default async function ProviderHomePage() {
  const supabase = await createClient();
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) redirect("/passkey-login");

  const admin = createAdminClient();

  // Fan out: provider_user (admin client), all enrolments (auth, RLS-scoped),
  // last 5 routed (auth), all routed sub ids (auth — for fastrack-ready
  // count), all fastrack parents (auth, RLS-scoped).
  const [puResult, enrolmentsResult, recentSubsResult, allRoutedResult, fastrackResult] =
    await Promise.all([
      admin
        .schema("crm")
        .from("provider_users")
        .select("id, provider_id, contact_email, display_name, role, enrolled_at, status")
        .eq("auth_user_id", user.id)
        .eq("status", "active")
        .maybeSingle<ProviderUserRow>(),
      supabase
        .schema("crm")
        .from("enrolments")
        .select("status, status_updated_at, callback_requested_at"),
      supabase
        .schema("leads")
        .from("submissions")
        .select("id, first_name, last_name, email, course_id, routed_at")
        .not("routed_at", "is", null)
        .is("archived_at", null)
        .is("parent_submission_id", null)
        .order("routed_at", { ascending: false })
        .limit(5),
      supabase
        .schema("leads")
        .from("submissions")
        .select("id")
        .not("routed_at", "is", null)
        .is("archived_at", null)
        .is("parent_submission_id", null),
      supabase
        .schema("leads")
        .from("fastrack_submissions")
        .select("parent_submission_id"),
    ]);

  const pu = puResult.data;
  if (!pu) {
    await supabase.auth.signOut();
    redirect("/passkey-login?error=no_active_account");
  }

  const recentSubs = (recentSubsResult.data ?? []) as RecentLeadRow[];
  const recentIds = recentSubs.map((s) => s.id);

  const [providerResult, recentEnrolsResult] = await Promise.all([
    admin
      .schema("crm")
      .from("providers")
      .select("company_name, per_enrolment_fee, free_enrolments_remaining")
      .eq("provider_id", pu.provider_id)
      .maybeSingle<ProviderRow>(),
    recentIds.length
      ? supabase
          .schema("crm")
          .from("enrolments")
          .select("submission_id, status, status_updated_at")
          .in("submission_id", recentIds)
      : Promise.resolve({ data: [] as RecentEnrolmentRow[] }),
  ]);

  const provider = providerResult.data;
  const enrolments = (enrolmentsResult.data ?? []) as EnrolmentCountRow[];
  const counts = countByStatus(enrolments);
  const enrolledThisMonth = enrolledThisMonthCount(enrolments);
  const enrolledLastMonth = enrolledLastMonthCount(enrolments);
  const callbackCount = enrolments.filter((r) => r.callback_requested_at != null).length;

  // Fastrack-ready = routed leads with a fastrack submission, NOT yet at a
  // settled enrolment status (still actionable).
  const allRoutedIds = new Set<number>(
    (allRoutedResult.data ?? []).map((r: RoutedSubIdRow) => r.id),
  );
  const fastrackParentIds = new Set<number>(
    (fastrackResult.data ?? []).map((r: FastrackParentRow) => r.parent_submission_id),
  );
  const fastrackReadyCount = [...fastrackParentIds].filter((id) => allRoutedIds.has(id)).length;

  // Estimated fees this month — naive: per_enrolment_fee × enrolledThisMonth.
  // (Free-enrolments accounting is a follow-up — provider's first 3 enrolments
  // are free per pilot pricing, but we'd need to know prior enrolments to
  // model that exactly.)
  const feesThisMonth = provider?.per_enrolment_fee != null
    ? provider.per_enrolment_fee * enrolledThisMonth
    : null;

  const recentEnrolBySub = new Map<number, RecentEnrolmentRow>();
  for (const e of (recentEnrolsResult.data ?? []) as RecentEnrolmentRow[]) {
    recentEnrolBySub.set(e.submission_id, e);
  }

  const monthDelta = enrolledThisMonth - enrolledLastMonth;
  const monthDeltaArrow = monthDelta > 0 ? "↑" : monthDelta < 0 ? "↓" : "→";
  const monthDeltaTone =
    monthDelta > 0 ? "text-emerald-700" : monthDelta < 0 ? "text-rose-700" : "text-slate-500";

  return (
    <ProviderShell active="home">
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        {/* Greeting */}
        <div>
          <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold">
            {provider?.company_name ?? pu.provider_id}
          </p>
          <h1 className="text-2xl font-semibold text-slate-900 mt-1">
            Welcome back, {pu.display_name ?? pu.contact_email}
          </h1>
        </div>

        {/* Hero stat strip */}
        <section className="bg-gradient-to-br from-slate-900 to-slate-800 text-white rounded-2xl p-6 md:p-8 shadow-sm">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <p className="text-xs uppercase tracking-widest text-slate-300 font-semibold">
                Enrolments this month
              </p>
              <p className="text-5xl md:text-6xl font-semibold tabular-nums mt-2 leading-none">
                {enrolledThisMonth}
              </p>
              <p className={`text-xs mt-3 font-medium ${monthDelta === 0 ? "text-slate-400" : monthDelta > 0 ? "text-emerald-300" : "text-rose-300"} tabular-nums`}>
                <span className={monthDeltaTone}>{monthDeltaArrow}</span>{" "}
                {monthDelta === 0
                  ? `same as last month (${enrolledLastMonth})`
                  : `${Math.abs(monthDelta)} ${monthDelta > 0 ? "more" : "fewer"} than last month (${enrolledLastMonth})`}
              </p>
            </div>

            <div className="border-t md:border-t-0 md:border-l border-slate-700 pt-4 md:pt-0 md:pl-6">
              <p className="text-xs uppercase tracking-widest text-slate-300 font-semibold">
                Estimated fees this month
              </p>
              <p className="text-3xl md:text-4xl font-semibold tabular-nums mt-2 leading-none">
                {feesThisMonth == null ? "—" : `£${feesThisMonth.toLocaleString("en-GB")}`}
              </p>
              <p className="text-xs mt-3 text-slate-400">
                {provider?.per_enrolment_fee != null
                  ? `£${provider.per_enrolment_fee} per enrolment`
                  : "Pricing on file unclear — message Charlotte"}
              </p>
            </div>

            <div className="border-t md:border-t-0 md:border-l border-slate-700 pt-4 md:pt-0 md:pl-6">
              <p className="text-xs uppercase tracking-widest text-slate-300 font-semibold">
                In your queue
              </p>
              <p className="text-3xl md:text-4xl font-semibold tabular-nums mt-2 leading-none">
                {counts.open + counts.in_progress}
              </p>
              <p className="text-xs mt-3 text-slate-400">
                {counts.open} open · {counts.in_progress} in progress
              </p>
            </div>
          </div>
        </section>

        {/* Action queue — only render when something needs attention */}
        {(callbackCount > 0 || fastrackReadyCount > 0 || counts.awaiting_long > 0) && (
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
              Needs your attention
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {callbackCount > 0 && (
                <ActionCard
                  href="/provider/leads?status=callback"
                  tone="rose"
                  count={callbackCount}
                  label={callbackCount === 1 ? "callback requested" : "callbacks requested"}
                  hint="Switchable flagged for follow-up"
                />
              )}
              {fastrackReadyCount > 0 && (
                <ActionCard
                  href="/provider/leads"
                  tone="violet"
                  count={fastrackReadyCount}
                  label={fastrackReadyCount === 1 ? "fastrack ready" : "fastrack ready"}
                  hint="Cohort confirmed, ready to enrol"
                />
              )}
              {counts.awaiting_long > 0 && (
                <ActionCard
                  href="/provider/leads?status=open"
                  tone="amber"
                  count={counts.awaiting_long}
                  label={counts.awaiting_long === 1 ? "stale open lead" : "stale open leads"}
                  hint="No contact attempt for 7+ days"
                />
              )}
            </div>
          </section>
        )}

        {/* Pipeline funnel */}
        <section className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-900">Your pipeline</h2>
            <Link
              href="/provider/leads"
              className="text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              See all leads &rarr;
            </Link>
          </div>
          <PipelineFunnel
            stages={[
              { label: "Open", value: counts.open, tone: "slate", href: "/provider/leads?status=open" },
              { label: "Calling", value: counts.attempts, tone: "amber", href: "/provider/leads?status=in_progress" },
              { label: "Meeting", value: counts.meeting_booked, tone: "blue", href: "/provider/leads?status=enrolment_meeting_booked" },
              { label: "Enrolled (mo)", value: enrolledThisMonth, tone: "emerald", href: "/provider/leads?status=enrolled" },
            ]}
          />
        </section>

        {/* Recent activity */}
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="flex items-baseline justify-between px-6 pt-5 pb-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Recently routed to you</h2>
              <p className="text-xs text-slate-500 mt-0.5">The last five leads. Click for full details.</p>
            </div>
            <Link
              href="/provider/leads"
              className="text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              See all &rarr;
            </Link>
          </div>
          {recentSubs.length === 0 ? (
            <p className="px-6 py-10 text-sm text-slate-500 text-center">
              No leads yet. New leads land here as they come in.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 border-t border-slate-100">
              {recentSubs.map((s) => {
                const enrol = recentEnrolBySub.get(s.id);
                const status = (enrol?.status ?? "open") as LeadStatus;
                const name = [s.first_name, s.last_name].filter(Boolean).join(" ") || s.email || `Lead ${s.id}`;
                return (
                  <li key={s.id} className="hover:bg-slate-50 transition-colors">
                    <Link href={`/provider/leads/${s.id}`} className="flex items-center justify-between px-6 py-3 gap-3 cursor-pointer">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900 truncate">{name}</p>
                        <p className="text-xs text-slate-500 truncate">{s.course_id ?? "—"}</p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-xs text-slate-500 tabular-nums">
                          <DurationTimer since={s.routed_at} />
                        </span>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${STATUS_TONE[status] ?? "bg-slate-100 text-slate-700 border-slate-200"}`}>
                          {STATUS_LABEL[status] ?? status}
                        </span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </ProviderShell>
  );
}

function ActionCard({
  href,
  tone,
  count,
  label,
  hint,
}: {
  href: string;
  tone: "rose" | "violet" | "amber";
  count: number;
  label: string;
  hint: string;
}) {
  const palette: Record<string, string> = {
    rose: "bg-rose-50 border-rose-200 hover:border-rose-300 hover:bg-rose-100 text-rose-900",
    violet:
      "bg-violet-50 border-violet-200 hover:border-violet-300 hover:bg-violet-100 text-violet-900",
    amber:
      "bg-amber-50 border-amber-200 hover:border-amber-300 hover:bg-amber-100 text-amber-900",
  };
  const numTone: Record<string, string> = {
    rose: "text-rose-700",
    violet: "text-violet-700",
    amber: "text-amber-700",
  };
  return (
    <Link
      href={href}
      className={`block p-4 rounded-xl border ${palette[tone]} transition-colors cursor-pointer`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className={`text-3xl font-semibold tabular-nums leading-none ${numTone[tone]}`}>
          {count}
        </p>
        <span className="text-xs font-semibold opacity-80">Review &rarr;</span>
      </div>
      <p className="text-sm font-medium mt-2">{label}</p>
      <p className="text-xs opacity-75 mt-0.5">{hint}</p>
    </Link>
  );
}

function PipelineFunnel({
  stages,
}: {
  stages: Array<{ label: string; value: number; tone: "slate" | "amber" | "blue" | "emerald"; href: string }>;
}) {
  const toneBar: Record<string, string> = {
    slate: "bg-slate-200",
    amber: "bg-amber-200",
    blue: "bg-blue-200",
    emerald: "bg-emerald-200",
  };
  const toneText: Record<string, string> = {
    slate: "text-slate-700",
    amber: "text-amber-800",
    blue: "text-blue-800",
    emerald: "text-emerald-800",
  };
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div className="space-y-2.5">
      {stages.map((s) => {
        const pct = Math.round((s.value / max) * 100);
        return (
          <Link
            key={s.label}
            href={s.href}
            className="flex items-center gap-3 group cursor-pointer"
          >
            <span className="w-20 shrink-0 text-xs font-medium text-slate-600 group-hover:text-slate-900 transition-colors">
              {s.label}
            </span>
            <div className="flex-1 h-7 bg-slate-50 rounded-md overflow-hidden">
              <div
                className={`${toneBar[s.tone]} h-full rounded-md transition-all group-hover:brightness-95`}
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>
            <span className={`w-8 shrink-0 text-sm font-semibold tabular-nums text-right ${toneText[s.tone]}`}>
              {s.value}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

function countByStatus(rows: EnrolmentCountRow[]) {
  let open = 0;
  let inProgress = 0;
  let attempts = 0;
  let meetingBooked = 0;
  let awaitingLong = 0;
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const r of rows) {
    if (r.status === "open") {
      open += 1;
      if (new Date(r.status_updated_at).getTime() < sevenDaysAgo) awaitingLong += 1;
    }
    if (
      r.status === "attempt_1_no_answer" ||
      r.status === "attempt_2_no_answer" ||
      r.status === "attempt_3_no_answer"
    ) {
      attempts += 1;
      inProgress += 1;
    }
    if (r.status === "enrolment_meeting_booked") {
      meetingBooked += 1;
      inProgress += 1;
    }
  }
  return { open, in_progress: inProgress, attempts, meeting_booked: meetingBooked, awaiting_long: awaitingLong };
}

function enrolledThisMonthCount(rows: EnrolmentCountRow[]): number {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return rows.filter(
    (r) =>
      (r.status === "enrolled" || r.status === "presumed_enrolled") &&
      new Date(r.status_updated_at).getTime() >= monthStart,
  ).length;
}

function enrolledLastMonthCount(rows: EnrolmentCountRow[]): number {
  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  return rows.filter((r) => {
    if (r.status !== "enrolled" && r.status !== "presumed_enrolled") return false;
    const t = new Date(r.status_updated_at).getTime();
    return t >= lastMonthStart && t < thisMonthStart;
  }).length;
}
