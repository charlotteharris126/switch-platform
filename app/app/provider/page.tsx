// /provider. gated home for authenticated provider users.
//
// At-a-glance dashboard:
//   - Hero strip: enrolments this month + month-on-month delta + estimated
//     fees-this-month if we have a per-enrolment fee on file
//   - Action queue: only renders cards that have non-zero counts (callbacks /
//     fastrack ready / stale opens). silent when nothing's urgent
//   - Pipeline funnel: visual breakdown of where leads sit, segments
//     proportional to count
//   - Recent activity: last 5 routed leads with duration + status
//
// All lead reads run as the authenticated role so RLS from migration 0096
// scopes everything to this provider automatically. Provider context (the
// pu + provider rows) loads via the admin client because crm.provider_users
// has admin-gated RLS that the authenticated session doesn't satisfy on
// self-lookup.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ProviderShell } from "./provider-shell";
import { ProviderHomeView } from "./home-view";
import type { LeadStatus } from "@/lib/lead-status";
import { RealtimeRefresh } from "@/components/realtime-refresh";

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
  funding_types: string[] | null;
  sla_stale_attempt_hours: number;
  sla_presumed_flip_days: number;
  sla_first_attempt_hours: number;
}

interface EnrolmentCountRow {
  submission_id: number;
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

interface RoutedIdRow {
  id: number;
  routed_at: string | null;
  utm_source: string | null;
}

interface FastrackTimedRow {
  parent_submission_id: number;
  submitted_at: string;
}

export default async function ProviderHomePage() {
  const supabase = await createClient();
  // Re-verify with the auth server, not cookie-only — defence-in-depth on
  // top of the proxy's getUser call. Costs ~80ms but happens once per page
  // paint, in parallel with no data dependency (we await it here only to
  // get user.id for the provider_user lookup below).
  const { data: userData } = await supabase.auth.getUser();
  const user = userData?.user;
  if (!user) redirect("/provider-login");

  const admin = createAdminClient();

  // Fan out: provider_user (admin client), all enrolments (auth, RLS-scoped),
  // last 5 routed (auth), all routed sub ids (auth. for fastrack-ready
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
        .select("submission_id, status, status_updated_at, callback_requested_at"),
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
        .select("id, routed_at, utm_source")
        .not("routed_at", "is", null)
        .is("archived_at", null)
        .is("parent_submission_id", null),
      supabase
        .schema("leads")
        .from("fastrack_submissions")
        .select("parent_submission_id, submitted_at"),
    ]);

  const pu = puResult.data;
  if (!pu) {
    await supabase.auth.signOut();
    redirect("/provider-login?error=no_active_account");
  }

  const recentSubs = (recentSubsResult.data ?? []) as RecentLeadRow[];
  const recentIds = recentSubs.map((s) => s.id);

  const [providerResult, recentEnrolsResult] = await Promise.all([
    admin
      .schema("crm")
      .from("providers")
      .select("company_name, funding_types, sla_stale_attempt_hours, sla_presumed_flip_days, sla_first_attempt_hours")
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
  const enrolledLast30d = enrolledLast30DaysCount(enrolments);
  const callbackCount = enrolments.filter((r) => r.callback_requested_at != null).length;

  // Build routed-id → routed_at lookup so we can find the oldest lead in
  // each "needs your attention" bucket.
  const allRouted = (allRoutedResult.data ?? []) as RoutedIdRow[];
  const routedAtById = new Map<number, string | null>();
  for (const r of allRouted) routedAtById.set(r.id, r.routed_at);
  const allRoutedIds = new Set<number>(allRouted.map((r) => r.id));

  // Fastrack-ready = routed leads with a fastrack submission AND status=open
  // (no enrolment row counts as open). Once the provider moves the status,
  // they've actioned the fastrack signal — it stops driving the home action
  // card. Stale attempts / callback signals are separate cards that re-fire
  // independently if a contact attempt then goes cold. Tightened 2026-05-11
  // (was: !settled-only, which kept fastracks visible across attempt_X /
  // cannot_reach / meeting_booked despite provider already engaging).
  const statusBySub = new Map<number, string>();
  for (const e of enrolments) statusBySub.set(e.submission_id, e.status);
  const fastrackRows = (fastrackResult.data ?? []) as FastrackTimedRow[];
  const fastrackParentIds = new Set<number>(fastrackRows.map((r) => r.parent_submission_id));
  const fastrackReadyIds = [...fastrackParentIds].filter((id) => {
    if (!allRoutedIds.has(id)) return false;
    const s = statusBySub.get(id);
    return s === undefined || s === "open";
  });
  const fastrackReadyCount = fastrackReadyIds.length;

  // Stale follow-ups = leads in attempt_1/2/3 with status_updated_at older
  // than the provider's SLA stale-attempt threshold. PPA v1 providers
  // default to 36h (daily-cadence learner workflow); PPA v2 (Riverside)
  // is set to 120h (5 days, weekly-cadence B2B). Read per-provider from
  // crm.providers.sla_stale_attempt_hours so each pilot carries its own
  // value.
  const STALE_ATTEMPT_HOURS = provider?.sla_stale_attempt_hours ?? 36;
  const staleAttemptCutoff = Date.now() - STALE_ATTEMPT_HOURS * 60 * 60 * 1000;
  const staleAttempts = enrolments.filter(
    (e) =>
      (e.status === "attempt_1_no_answer" ||
        e.status === "attempt_2_no_answer" ||
        e.status === "attempt_3_no_answer") &&
      new Date(e.status_updated_at).getTime() < staleAttemptCutoff,
  );
  const staleAttemptCount = staleAttempts.length;

  // Oldest "since" timestamp per attention bucket — the live counter on
  // each card shows how long this bucket has been waiting on the provider.
  const oldestCallbackSince = oldestIso(
    enrolments
      .filter((e) => e.callback_requested_at != null)
      .map((e) => e.callback_requested_at as string),
  );
  const oldestFastrackSince = oldestIso(
    fastrackRows
      .filter((r) => {
        if (!allRoutedIds.has(r.parent_submission_id)) return false;
        const s = statusBySub.get(r.parent_submission_id);
        return s === undefined || s === "open";
      })
      .map((r) => r.submitted_at),
  );
  const oldestOpenSince = oldestIso(
    enrolments
      .filter((e) => e.status === "open")
      .map((e) => routedAtById.get(e.submission_id) ?? null)
      .filter((v): v is string => v != null),
  );
  const oldestStaleAttemptSince = oldestIso(
    staleAttempts.map((e) => e.status_updated_at),
  );

  const recentEnrolBySub = new Map<number, RecentEnrolmentRow>();
  for (const e of (recentEnrolsResult.data ?? []) as RecentEnrolmentRow[]) {
    recentEnrolBySub.set(e.submission_id, e);
  }

  // Pre-compute the nav "action needed" badge count from data already in
  // memory so ProviderShell can skip its own Suspense fetch on home.
  // Matches LeadsNavLink's definition exactly: callback-pending OR
  // fastrack-ready (not settled) OR open OR stale-attempt (36h+).
  const actionCount =
    callbackCount +
    fastrackReadyCount +
    counts.open +
    staleAttemptCount;

  // Overdue thresholds — when the oldest item in a bucket has been
  // waiting longer than these, the home card shows an Overdue badge.
  // Mirrors the per-row overdue logic in leads-table.tsx so the home
  // glance matches the list-level signal. Open-overdue follows the
  // first-attempt SLA; the 36h-style threshold for callback +
  // stale-attempt follows the provider's stale-attempt SLA so the
  // signal matches the cadence Jane / Andy work to.
  const OVERDUE_OPEN_MS = (provider?.sla_first_attempt_hours ?? 24) * 60 * 60 * 1000;
  const OVERDUE_36H_MS = STALE_ATTEMPT_HOURS * 60 * 60 * 1000;
  const overdueOpen = isOlderThan(oldestOpenSince, OVERDUE_OPEN_MS);
  const overdueCallback = isOlderThan(oldestCallbackSince, OVERDUE_36H_MS);
  const overdueStaleAttempt = isOlderThan(oldestStaleAttemptSince, OVERDUE_36H_MS);
  // Fastrack: don't flag overdue purely on age — the call-in window is
  // the provider's responsibility but we don't have a hard SLA here yet.
  const overdueFastrack = false;

  // Employer-shape home: trigger when the provider serves apprenticeships
  // (Riverside in v1). Drives the home view's "Needs your attention" +
  // "Your pipeline" sections to render employer-shaped cards instead of
  // learner-shaped ones. Day-1 Riverside has zero leads, so all cards
  // will read 0; this just makes the labels match the workflow.
  const isEmployerProvider =
    Array.isArray(provider?.funding_types)
    && provider!.funding_types!.includes("apprenticeship");

  // Employer-shape counts. All compute from the same enrolments rows;
  // RLS already scoped to this provider.
  let employerEngagedCount = 0;
  let employerInProgressCount = 0;
  let employerSignedCount = 0;
  let employerNotSignedCount = 0;
  // "60-day clock approaching" = engaged or in_progress with no status
  // update in 50+ days (10-day warning before the 60-day Presumed Employer
  // Signed auto-flip).
  const FIFTY_DAYS_MS = 50 * 24 * 60 * 60 * 1000;
  let employerNear60DayCount = 0;
  for (const e of enrolments) {
    const ageMs = Date.now() - new Date(e.status_updated_at).getTime();
    if (e.status === "engaged") {
      employerEngagedCount += 1;
      if (ageMs > FIFTY_DAYS_MS) employerNear60DayCount += 1;
    } else if (e.status === "in_progress") {
      employerInProgressCount += 1;
      if (ageMs > FIFTY_DAYS_MS) employerNear60DayCount += 1;
    } else if (e.status === "signed" || e.status === "presumed_employer_signed") {
      employerSignedCount += 1;
    } else if (e.status === "not_signed") {
      employerNotSignedCount += 1;
    }
  }

  const recentLeads = recentSubs.map((s) => {
    const enrol = recentEnrolBySub.get(s.id);
    const name = [s.first_name, s.last_name].filter(Boolean).join(" ") || s.email || `Lead ${s.id}`;
    return {
      id: s.id,
      name,
      course_id: s.course_id,
      routed_at: s.routed_at,
      status: (enrol?.status ?? "open") as LeadStatus,
    };
  });

  return (
    <ProviderShell active="home" actionCount={actionCount}>
      <RealtimeRefresh
        tables={[
          { schema: "leads", table: "submissions", filter: `primary_routed_to=eq.${pu.provider_id}` },
          { schema: "crm", table: "enrolments", filter: `provider_id=eq.${pu.provider_id}` },
          { schema: "crm", table: "lead_notes", filter: `provider_id=eq.${pu.provider_id}` },
        ]}
        channel={`rt-provider-home-${pu.provider_id}`}
      />
      <ProviderHomeView
        providerLabel={provider?.company_name ?? pu.provider_id}
        greetingName={pu.display_name ?? pu.contact_email}
        leadType={isEmployerProvider ? "employer_apprenticeship" : "learner"}
        enrolledLast30d={enrolledLast30d}
        counts={counts}
        callbackCount={callbackCount}
        fastrackReadyCount={fastrackReadyCount}
        staleAttemptCount={staleAttemptCount}
        employerCounts={{
          engaged: employerEngagedCount,
          in_progress: employerInProgressCount,
          signed: employerSignedCount,
          not_signed: employerNotSignedCount,
          near_60_day: employerNear60DayCount,
        }}
        oldestCallbackSince={oldestCallbackSince}
        oldestFastrackSince={oldestFastrackSince}
        oldestOpenSince={oldestOpenSince}
        oldestStaleAttemptSince={oldestStaleAttemptSince}
        recentLeads={recentLeads}
        overdueFastrack={overdueFastrack}
        overdueCallback={overdueCallback}
        overdueOpen={overdueOpen}
        overdueStaleAttempt={overdueStaleAttempt}
        leadsBase="/provider"
        leadDetailPrefix="/provider/leads/"
      />
    </ProviderShell>
  );
}

function isOlderThan(iso: string | null, thresholdMs: number): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() > thresholdMs;
}

function oldestIso(values: string[]): string | null {
  if (values.length === 0) return null;
  let oldest = values[0];
  let oldestTime = new Date(oldest).getTime();
  for (const v of values) {
    const t = new Date(v).getTime();
    if (t < oldestTime) {
      oldest = v;
      oldestTime = t;
    }
  }
  return oldest;
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

function enrolledLast30DaysCount(rows: EnrolmentCountRow[]): number {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return rows.filter(
    (r) =>
      (r.status === "enrolled" || r.status === "presumed_enrolled") &&
      new Date(r.status_updated_at).getTime() >= cutoff,
  ).length;
}
