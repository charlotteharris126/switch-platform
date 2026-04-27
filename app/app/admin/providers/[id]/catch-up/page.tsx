import Link from "next/link";
import { notFound } from "next/navigation";
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
import { formatDate, formatDateTime } from "@/lib/format";
import { ProviderTabs } from "../tabs";
import { RealtimeRefresh } from "@/components/realtime-refresh";

const LOST_REASON_LABELS: Record<string, string> = {
  not_interested: "Not interested",
  wrong_course:   "Wrong course",
  funding_issue:  "Funding issue",
  other:          "Other",
};

const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;
const TWENTY_ONE_DAYS_MS = 21 * 24 * 3600 * 1000;

export default async function ProviderCatchUpPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: raw } = await params;
  const providerId = decodeURIComponent(raw);
  const supabase = await createClient();

  const [{ data: provider, error: provErr }, { data: billingState }] = await Promise.all([
    supabase
      .schema("crm")
      .from("providers")
      .select("provider_id, company_name, contact_name, contact_email, pilot_status, active")
      .eq("provider_id", providerId)
      .maybeSingle(),
    supabase
      .schema("crm")
      .from("vw_provider_billing_state")
      .select("free_enrolments_remaining, free_enrolments_used, billable_count")
      .eq("provider_id", providerId)
      .maybeSingle(),
  ]);
  if (provErr) {
    return <div className="text-[#b3412e]">Error loading provider: {provErr.message}</div>;
  }
  if (!provider) notFound();

  // Use live derived value rather than the static crm.providers column.
  const freeRemaining = billingState?.free_enrolments_remaining ?? null;
  const freeUsed = billingState?.free_enrolments_used ?? 0;
  const billableCount = billingState?.billable_count ?? 0;

  const sevenDaysAgo  = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();

  // All queries scoped to this provider. Run in parallel.
  const [
    enrolmentsRes,
    routingWeekRes,
    routingAllTimeRes,
    recentRoutingRes,
    staleOpenRes,
    longOpenRes,
    reAppsThisMonthRes,
    activeDisputesRes,
  ] = await Promise.all([
    // All enrolments for this provider — drives the status counts, lost reasons,
    // sheet hygiene, and the recent activity table.
    supabase
      .schema("crm")
      .from("enrolments")
      .select("id, submission_id, status, lost_reason, disputed_at, disputed_reason, sent_to_provider_at, status_updated_at, updated_at, notes")
      .eq("provider_id", providerId)
      .order("status_updated_at", { ascending: false }),

    // Leads routed to this provider in last 7 days
    supabase
      .schema("leads")
      .from("routing_log")
      .select("id", { count: "exact", head: true })
      .eq("provider_id", providerId)
      .gte("routed_at", sevenDaysAgo),

    // Leads routed to this provider, all time (for conversion calc)
    supabase
      .schema("leads")
      .from("routing_log")
      .select("id", { count: "exact", head: true })
      .eq("provider_id", providerId),

    // Recent routing (30 days) — used for the activity table + speed-of-contact-ish
    supabase
      .schema("leads")
      .from("routing_log")
      .select("id, submission_id, routed_at")
      .eq("provider_id", providerId)
      .gte("routed_at", thirtyDaysAgo)
      .order("routed_at", { ascending: false }),

    // Stale "open" leads — provider hasn't touched in 7+ days. Talking point.
    supabase
      .schema("crm")
      .from("enrolments")
      .select("id", { count: "exact", head: true })
      .eq("provider_id", providerId)
      .eq("status", "open")
      .lt("status_updated_at", sevenDaysAgo),

    // Long-open leads (still open after 21 days) — talking point.
    supabase
      .schema("crm")
      .from("enrolments")
      .select("id, submission_id, sent_to_provider_at")
      .eq("provider_id", providerId)
      .eq("status", "open")
      .lt("sent_to_provider_at", new Date(Date.now() - TWENTY_ONE_DAYS_MS).toISOString())
      .order("sent_to_provider_at", { ascending: true }),

    // Re-applications in last 30 days — joined from this provider's known submissions
    // is expensive. Cheaper: fetch parent submission IDs for this provider's routing
    // log (last 90d), then count children where parent_id IN that set and submitted
    // in last 30d. Approximated below in two queries.
    supabase
      .schema("leads")
      .from("submissions")
      .select("id, parent_submission_id, submitted_at, first_name, last_name", { count: "exact" })
      .not("parent_submission_id", "is", null)
      .gte("submitted_at", thirtyDaysAgo)
      .neq("dq_reason", "waitlist_enrichment"),

    // Active disputes (rows still in presumed_enrolled with a dispute flag set)
    supabase
      .schema("crm")
      .from("enrolments")
      .select("id, submission_id, disputed_at, disputed_reason", { count: "exact" })
      .eq("provider_id", providerId)
      .eq("status", "presumed_enrolled")
      .not("disputed_at", "is", null),
  ]);

  type EnrolmentRow = {
    id: number;
    submission_id: number;
    status: string;
    lost_reason: string | null;
    disputed_at: string | null;
    disputed_reason: string | null;
    sent_to_provider_at: string | null;
    status_updated_at: string | null;
    updated_at: string | null;
    notes: string | null;
  };

  const enrolments        = (enrolmentsRes.data ?? []) as EnrolmentRow[];
  const routedThisWeek    = routingWeekRes.count ?? 0;
  const routedAllTime     = routingAllTimeRes.count ?? 0;
  const recentRouting     = (recentRoutingRes.data ?? []) as Array<{ id: number; submission_id: number; routed_at: string }>;
  const staleOpen         = staleOpenRes.count ?? 0;
  const longOpen          = (longOpenRes.data ?? []) as Array<{ id: number; submission_id: number; sent_to_provider_at: string }>;
  const activeDisputes    = (activeDisputesRes.data ?? []) as Array<{ id: number; submission_id: number; disputed_at: string; disputed_reason: string | null }>;

  // Per-status counts (this week + all-time)
  const enrolmentsThisWeek = enrolments.filter(
    (e) => e.status_updated_at && new Date(e.status_updated_at).getTime() >= Date.now() - SEVEN_DAYS_MS,
  );
  const countByStatus = (rows: EnrolmentRow[], status: string) => rows.filter((r) => r.status === status).length;

  const wkEnrolled    = countByStatus(enrolmentsThisWeek, "enrolled");
  const wkPresumed    = countByStatus(enrolmentsThisWeek, "presumed_enrolled");
  const wkCannotReach = countByStatus(enrolmentsThisWeek, "cannot_reach");
  const wkLost        = countByStatus(enrolmentsThisWeek, "lost");

  const allEnrolled    = countByStatus(enrolments, "enrolled");
  const allPresumed    = countByStatus(enrolments, "presumed_enrolled");
  const allCannotReach = countByStatus(enrolments, "cannot_reach");
  const allLost        = countByStatus(enrolments, "lost");
  const allOpen        = countByStatus(enrolments, "open");

  // Conversion = enrolled / (enrolled + presumed + cannot_reach + lost). Excludes
  // 'open' rows because the outcome isn't known yet — including them deflates
  // the rate while leads are still in flight.
  const decided   = allEnrolled + allPresumed + allCannotReach + allLost;
  const conversion = decided > 0 ? Math.round((allEnrolled / decided) * 100) : null;

  // Lost reason breakdown (all-time, this provider)
  const lostRows = enrolments.filter((e) => e.status === "lost");
  const lostByReason: Record<string, number> = { not_interested: 0, wrong_course: 0, funding_issue: 0, other: 0, unspecified: 0 };
  for (const r of lostRows) {
    const key = r.lost_reason ?? "unspecified";
    lostByReason[key] = (lostByReason[key] ?? 0) + 1;
  }
  const lostMax = Math.max(1, ...Object.values(lostByReason));

  // Re-applications: this query returned ALL re-applications (workspace-wide) in
  // last 30d. Filter to this provider's parents.
  const parentSubmissionIds = new Set(recentRouting.map((r) => r.submission_id));
  // We also need a wider parent set than just last 30d routing — leads routed
  // months ago can re-apply now. Use all-time routing for this provider as the
  // parent universe.
  const allParentRouting = await supabase
    .schema("leads")
    .from("routing_log")
    .select("submission_id")
    .eq("provider_id", providerId);
  const allParentIds = new Set((allParentRouting.data ?? []).map((r: { submission_id: number }) => r.submission_id));

  const reApps = (reAppsThisMonthRes.data ?? []) as Array<{
    id: number;
    parent_submission_id: number;
    submitted_at: string;
    first_name: string | null;
    last_name: string | null;
  }>;
  const reAppsForThisProvider = reApps.filter((r) => allParentIds.has(r.parent_submission_id));

  // Sheet hygiene — most recent enrolment update across this provider
  const lastUpdate = enrolments.reduce<string | null>((acc, e) => {
    const t = e.status_updated_at ?? e.updated_at;
    if (!t) return acc;
    return acc && acc > t ? acc : t;
  }, null);
  const lastUpdateAgoDays = lastUpdate ? Math.floor((Date.now() - new Date(lastUpdate).getTime()) / (24 * 3600 * 1000)) : null;

  // By-course breakdown (all-time): fetch course_id for every submission this
  // provider has been routed. We already have an enrolment row per routed lead
  // (route-lead.ts inserts one on routing), so enrolment.submission_id is the
  // universe. One extra query for course_id mapping.
  const allRoutedSubIds = Array.from(new Set(enrolments.map((e) => e.submission_id)));
  let courseBySubId = new Map<number, string | null>();
  if (allRoutedSubIds.length > 0) {
    const { data: courseData } = await supabase
      .schema("leads")
      .from("submissions")
      .select("id, course_id")
      .in("id", allRoutedSubIds);
    courseBySubId = new Map((courseData ?? []).map((s: { id: number; course_id: string | null }) => [s.id, s.course_id]));
  }

  type CourseStats = { routed: number; enrolled: number; presumed: number; cannot_reach: number; lost: number; open: number };
  const byCourse: Record<string, CourseStats> = {};
  for (const e of enrolments) {
    const cid = courseBySubId.get(e.submission_id) ?? "(unknown)";
    if (!byCourse[cid]) byCourse[cid] = { routed: 0, enrolled: 0, presumed: 0, cannot_reach: 0, lost: 0, open: 0 };
    byCourse[cid].routed++;
    if (e.status === "enrolled")          byCourse[cid].enrolled++;
    if (e.status === "presumed_enrolled") byCourse[cid].presumed++;
    if (e.status === "cannot_reach")      byCourse[cid].cannot_reach++;
    if (e.status === "lost")              byCourse[cid].lost++;
    if (e.status === "open")              byCourse[cid].open++;
  }
  // Sort courses by routed-volume descending so the busiest courses lead
  const courseRows = Object.entries(byCourse)
    .map(([course, stats]) => {
      const decided = stats.enrolled + stats.presumed + stats.cannot_reach + stats.lost;
      const conv = decided > 0 ? Math.round((stats.enrolled / decided) * 100) : null;
      return { course, ...stats, decided, conv };
    })
    .sort((a, b) => b.routed - a.routed);

  // Build talking points — auto-generated, human-readable
  const talkingPoints: Array<{ kind: "warn" | "info" | "good"; text: string }> = [];
  if (staleOpen > 0) {
    talkingPoints.push({
      kind: "warn",
      text: `${staleOpen} ${staleOpen === 1 ? "lead has" : "leads have"} been "open" with no status update for 7+ days. Remind them to mark contact attempts as they go, not just at the third no-answer.`,
    });
  }
  if (longOpen.length > 0) {
    talkingPoints.push({
      kind: "warn",
      text: `${longOpen.length} ${longOpen.length === 1 ? "lead is" : "leads are"} still "open" 21+ days after being routed. Worth a direct status check — anything stuck this long is a signal.`,
    });
  }
  if (activeDisputes.length > 0) {
    talkingPoints.push({
      kind: "warn",
      text: `${activeDisputes.length} active ${activeDisputes.length === 1 ? "dispute" : "disputes"} on presumed-enrolled leads. Resolve before billing.`,
    });
  }
  if (allCannotReach >= 3) {
    talkingPoints.push({
      kind: "info",
      text: `${allCannotReach} cannot-reach total. If this is climbing, the call-from numbers + preferred-call-time tickets may help — worth a chat about both.`,
    });
  }
  if (reAppsForThisProvider.length > 0) {
    talkingPoints.push({
      kind: "info",
      text: `${reAppsForThisProvider.length} re-${reAppsForThisProvider.length === 1 ? "application" : "applications"} from people previously routed to this provider in the last 30 days. Worth checking if any are worth re-engaging.`,
    });
  }
  if (freeRemaining === 1) {
    talkingPoints.push({
      kind: "info",
      text: `On the last free enrolment. Next confirmed enrolment triggers billing — make sure GoCardless mandate is in place.`,
    });
  } else if (freeRemaining === 0 && billableCount === 0) {
    talkingPoints.push({
      kind: "info",
      text: `Free enrolments used up. Next confirmed enrolment is billable.`,
    });
  } else if (billableCount > 0) {
    talkingPoints.push({
      kind: "info",
      text: `${billableCount} billable enrolment${billableCount === 1 ? "" : "s"} so far (past the 3 free).`,
    });
  }
  if (lastUpdateAgoDays !== null && lastUpdateAgoDays >= 7) {
    talkingPoints.push({
      kind: "warn",
      text: `Sheet/tracker hasn't seen a status update in ${lastUpdateAgoDays} days. Either no leads need an update (good) or updates aren't happening (bad). Check.`,
    });
  }
  if (talkingPoints.length === 0) {
    talkingPoints.push({
      kind: "good",
      text: `No flags. Standard catch-up: lead quality, blockers, what would help next week.`,
    });
  }

  // Recent activity table — last 30 days of routing, joined with enrolment state
  const enrolmentBySubId = new Map<number, EnrolmentRow>();
  for (const e of enrolments) enrolmentBySubId.set(e.submission_id, e);

  // Pull learner names for the routed submissions (last 30d)
  const recentSubIds = recentRouting.map((r) => r.submission_id);
  const recentSubsById = new Map<number, { id: number; first_name: string | null; last_name: string | null; course_id: string | null }>();
  if (recentSubIds.length > 0) {
    const { data: subData } = await supabase
      .schema("leads")
      .from("submissions")
      .select("id, first_name, last_name, course_id")
      .in("id", recentSubIds);
    for (const s of (subData ?? [])) recentSubsById.set(s.id, s);
  }

  // The set we'll display: all routing in last 30d + their current enrolment status
  const activity = recentRouting.map((r) => {
    const sub = recentSubsById.get(r.submission_id);
    const enr = enrolmentBySubId.get(r.submission_id);
    return {
      submissionId: r.submission_id,
      routedAt:     r.routed_at,
      name:         sub ? [sub.first_name, sub.last_name].filter(Boolean).join(" ") || "—" : "—",
      courseId:     sub?.course_id ?? null,
      status:       enr?.status ?? "open",
      lostReason:   enr?.lost_reason ?? null,
      disputedAt:   enr?.disputed_at ?? null,
    };
  });

  return (
    <div className="max-w-6xl space-y-6">
      <RealtimeRefresh
        tables={[
          { schema: "crm", table: "enrolments" },
          { schema: "leads", table: "routing_log" },
          { schema: "leads", table: "submissions" },
        ]}
        channel={`rt-provider-catchup-${providerId}`}
      />

      {/* Header + tabs */}
      <div>
        <Link href="/providers" className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#cd8b76] hover:text-[#b3412e]">
          ← Back to providers
        </Link>
        <h1 className="text-[28px] font-extrabold text-[#11242e] mt-2 tracking-tight">
          {provider.company_name}
        </h1>
        <div className="flex gap-2 mt-2 items-center">
          {provider.active ? (
            <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Active</Badge>
          ) : (
            <Badge variant="secondary">Inactive</Badge>
          )}
          {provider.pilot_status && <Badge variant="secondary">{provider.pilot_status}</Badge>}
          <span className="text-xs text-[#5a6a72] font-mono">{provider.provider_id}</span>
        </div>
      </div>

      <ProviderTabs providerId={providerId} active="catch-up" />

      {/* Section: Lead quality at a glance */}
      <div>
        <h2 className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">This week (last 7 days)</h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatTile label="Routed" value={routedThisWeek} />
          <StatTile label="Enrolled" value={wkEnrolled} emphasis="good" />
          <StatTile label="Presumed" value={wkPresumed} />
          <StatTile label="Cannot reach" value={wkCannotReach} emphasis={wkCannotReach > 0 ? "warn" : undefined} />
          <StatTile label="Lost" value={wkLost} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">All-time conversion</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-4xl font-extrabold text-[#11242e] tracking-tight">
              {conversion === null ? "—" : `${conversion}%`}
            </p>
            <p className="text-[10px] text-[#5a6a72] mt-2">
              {allEnrolled} enrolled of {decided} decided
              {allOpen > 0 ? ` (${allOpen} still open, not counted)` : ""}.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">Free enrolments left</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-4xl font-extrabold tracking-tight">
              <span className={freeRemaining === 0 ? "text-[#cd8b76]" : "text-[#11242e]"}>
                {freeRemaining ?? "—"}
              </span>
              <span className="text-xl font-bold text-[#5a6a72]"> / 3</span>
            </p>
            <p className="text-[10px] text-[#5a6a72] mt-2">
              {freeRemaining === 0
                ? `All free enrolments used. ${billableCount > 0 ? `${billableCount} billable so far.` : "Next confirmed enrolment is billable."}`
                : `${freeUsed} of 3 used during pilot.`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">All-time totals</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xs text-[#11242e] space-y-1">
              <div className="flex justify-between"><span>Routed</span><span className="font-bold">{routedAllTime}</span></div>
              <div className="flex justify-between"><span>Enrolled</span><span className="font-bold text-emerald-700">{allEnrolled}</span></div>
              <div className="flex justify-between"><span>Presumed enrolled</span><span className="font-bold">{allPresumed}</span></div>
              <div className="flex justify-between"><span>Cannot reach</span><span className="font-bold">{allCannotReach}</span></div>
              <div className="flex justify-between"><span>Lost</span><span className="font-bold">{allLost}</span></div>
              <div className="flex justify-between"><span>Open</span><span className="font-bold">{allOpen}</span></div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Section: Talking points */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Talking points for the call</CardTitle>
          <p className="text-xs text-[#5a6a72] mt-1">
            Auto-generated from current state. Use these as nudges, not a script.
          </p>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {talkingPoints.map((tp, i) => (
              <li key={i} className="flex gap-3 items-start">
                <span
                  className={
                    "mt-1 inline-block w-2 h-2 rounded-full flex-shrink-0 " +
                    (tp.kind === "warn" ? "bg-[#cd8b76]" : tp.kind === "good" ? "bg-emerald-500" : "bg-[#143643]")
                  }
                />
                <span className="text-sm text-[#11242e] leading-relaxed">{tp.text}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Section: Common lost reasons */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Common lost reasons (all-time)</CardTitle>
          <p className="text-xs text-[#5a6a72] mt-1">
            Why leads close as Lost. Cannot-reach is tracked separately.
          </p>
        </CardHeader>
        <CardContent>
          {lostRows.length === 0 ? (
            <p className="text-xs text-[#5a6a72]">No lost leads yet.</p>
          ) : (
            <div className="space-y-2">
              {Object.entries(lostByReason)
                .filter(([_, count]) => count > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, count]) => {
                  const label = reason === "unspecified" ? "Unspecified (legacy)" : LOST_REASON_LABELS[reason] ?? reason;
                  const pct = (count / lostMax) * 100;
                  return (
                    <div key={reason} className="flex items-center gap-3">
                      <span className="text-xs w-32 text-[#11242e]">{label}</span>
                      <div className="flex-1 bg-[#f4f1ed] rounded-full h-3 relative overflow-hidden">
                        <div
                          className="absolute inset-y-0 left-0 bg-[#cd8b76] rounded-full"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-xs font-bold text-[#11242e] w-8 text-right">{count}</span>
                    </div>
                  );
                })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section: By course (all-time) */}
      {courseRows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">By course (all-time)</CardTitle>
            <p className="text-xs text-[#5a6a72] mt-1">
              Conversion + outcome split per course. Helps spot which courses convert well and which need attention.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Course</TableHead>
                  <TableHead className="text-right">Routed</TableHead>
                  <TableHead className="text-right">Conversion</TableHead>
                  <TableHead className="text-right">Enrolled</TableHead>
                  <TableHead className="text-right">Presumed</TableHead>
                  <TableHead className="text-right">Cannot reach</TableHead>
                  <TableHead className="text-right">Lost</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {courseRows.map((r) => (
                  <TableRow key={r.course} className="hover:bg-[#f4f1ed]/60">
                    <TableCell className="text-xs font-mono text-[#11242e]">{r.course}</TableCell>
                    <TableCell className="text-xs text-right font-bold">{r.routed}</TableCell>
                    <TableCell className="text-xs text-right font-bold text-[#143643]">
                      {r.conv === null ? "—" : `${r.conv}%`}
                    </TableCell>
                    <TableCell className="text-xs text-right text-emerald-700 font-bold">{r.enrolled}</TableCell>
                    <TableCell className="text-xs text-right">{r.presumed}</TableCell>
                    <TableCell className="text-xs text-right">{r.cannot_reach}</TableCell>
                    <TableCell className="text-xs text-right">{r.lost}</TableCell>
                    <TableCell className="text-xs text-right text-[#5a6a72]">{r.open}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Section: Active disputes (only shown if any) */}
      {activeDisputes.length > 0 && (
        <Card className="border-[#cd8b76]/60 bg-[#fbf9f5]">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              Active disputes
              <Badge className="bg-[#cd8b76] text-white text-[10px] hover:bg-[#cd8b76]">{activeDisputes.length}</Badge>
            </CardTitle>
            <p className="text-xs text-[#5a6a72] mt-1">
              Provider has rebutted these presumed-enrolled rows. Resolve before billing.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Lead</TableHead>
                  <TableHead>Disputed at</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeDisputes.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-mono text-xs">
                      <Link href={`/leads/${d.submission_id}`} className="text-[#cd8b76] hover:text-[#b3412e] font-semibold">
                        {d.submission_id}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{formatDateTime(d.disputed_at)}</TableCell>
                    <TableCell className="text-xs text-[#5a6a72]">{d.disputed_reason ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Section: Re-applications */}
      {reAppsForThisProvider.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Re-applications (last 30 days)</CardTitle>
            <p className="text-xs text-[#5a6a72] mt-1">
              People previously routed here who came back through the funnel. Worth checking if any are worth re-engaging.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Original lead</TableHead>
                  <TableHead>Re-application</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reAppsForThisProvider.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs whitespace-nowrap">{formatDate(r.submitted_at)}</TableCell>
                    <TableCell className="text-sm">
                      {[r.first_name, r.last_name].filter(Boolean).join(" ") || "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <Link href={`/leads/${r.parent_submission_id}`} className="text-[#cd8b76] hover:text-[#b3412e]">
                        #{r.parent_submission_id}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <Link href={`/leads/${r.id}`} className="text-[#cd8b76] hover:text-[#b3412e]">
                        #{r.id}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Section: Recent activity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Recent activity (last 30 days)</CardTitle>
          <p className="text-xs text-[#5a6a72] mt-1">
            Every lead routed to this provider in the last 30 days, with current outcome state. Use as a reference during the call.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {activity.length === 0 ? (
            <p className="text-xs text-[#5a6a72] p-4">No leads routed in the last 30 days.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Lead</TableHead>
                  <TableHead>Routed</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Course</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activity.map((a) => (
                  <TableRow key={a.submissionId} className="hover:bg-[#f4f1ed]/60">
                    <TableCell className="font-mono text-xs">
                      <Link href={`/leads/${a.submissionId}`} className="text-[#cd8b76] hover:text-[#b3412e] font-semibold">
                        {a.submissionId}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{formatDate(a.routedAt)}</TableCell>
                    <TableCell className="text-sm">{a.name}</TableCell>
                    <TableCell className="text-xs text-[#5a6a72]">{a.courseId ?? "—"}</TableCell>
                    <TableCell className="text-xs">
                      <StatusBadge status={a.status} lostReason={a.lostReason} disputed={Boolean(a.disputedAt)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatTile({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: number;
  emphasis?: "good" | "warn";
}) {
  const valueColor =
    emphasis === "good" ? "text-emerald-700" :
    emphasis === "warn" ? "text-[#cd8b76]" :
    "text-[#11242e]";
  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-4">
      <p className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">{label}</p>
      <p className={`text-3xl font-extrabold mt-1 tracking-tight ${valueColor}`}>{value}</p>
    </div>
  );
}

function StatusBadge({
  status,
  lostReason,
  disputed,
}: {
  status: string;
  lostReason: string | null;
  disputed: boolean;
}) {
  const label = status.replace(/_/g, " ");
  const color =
    status === "enrolled"          ? "bg-emerald-100 text-emerald-800" :
    status === "presumed_enrolled" ? "bg-[#143643] text-white"          :
    status === "cannot_reach"      ? "bg-[#cd8b76]/20 text-[#143643]"   :
    status === "lost"              ? "bg-[#dad4cb] text-[#143643]"      :
    "bg-[#f4f1ed] text-[#5a6a72]";
  return (
    <div className="flex flex-wrap gap-1 items-center">
      <Badge className={`text-[10px] uppercase tracking-wide ${color} hover:${color}`}>{label}</Badge>
      {status === "lost" && lostReason && (
        <span className="text-[10px] text-[#5a6a72]">({LOST_REASON_LABELS[lostReason] ?? lostReason})</span>
      )}
      {disputed && (
        <Badge className="text-[10px] bg-[#cd8b76] text-white hover:bg-[#cd8b76]">DISPUTED</Badge>
      )}
    </div>
  );
}
