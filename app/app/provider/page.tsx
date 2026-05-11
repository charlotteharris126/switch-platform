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
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) redirect("/passkey-login");

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
    redirect("/passkey-login?error=no_active_account");
  }

  const recentSubs = (recentSubsResult.data ?? []) as RecentLeadRow[];
  const recentIds = recentSubs.map((s) => s.id);

  const [providerResult, recentEnrolsResult] = await Promise.all([
    admin
      .schema("crm")
      .from("providers")
      .select("company_name")
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

  // Fastrack-ready = routed leads with a fastrack submission, NOT yet at a
  // settled enrolment status (still actionable).
  const fastrackRows = (fastrackResult.data ?? []) as FastrackTimedRow[];
  const fastrackParentIds = new Set<number>(fastrackRows.map((r) => r.parent_submission_id));
  const fastrackReadyIds = [...fastrackParentIds].filter((id) => allRoutedIds.has(id));
  const fastrackReadyCount = fastrackReadyIds.length;

  // Stale follow-ups = leads in attempt_1/2/3 with status_updated_at >48h ago.
  // Provider rang once, no answer, hasn't tried again. Caller's nudge.
  const STALE_ATTEMPT_HOURS = 48;
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
      .filter((r) => allRoutedIds.has(r.parent_submission_id))
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

  // Lead source breakdown — last 30 days routed leads grouped by
  // utm_source (empty/null bucketed as "direct"). Top 5 sources by
  // count. ProviderHomeView renders the bars; we just shape the data.
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const sourceCounts = new Map<string, number>();
  for (const r of allRouted) {
    if (!r.routed_at || new Date(r.routed_at).getTime() < thirtyDaysAgo) continue;
    const source = r.utm_source && r.utm_source.trim() !== "" ? r.utm_source.trim() : "direct";
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }
  const sourceBreakdown = [...sourceCounts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

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
    <ProviderShell active="home">
      <RealtimeRefresh
        tables={[
          { schema: "leads", table: "submissions" },
          { schema: "crm", table: "enrolments" },
          { schema: "crm", table: "lead_notes" },
        ]}
        channel="rt-provider-home"
      />
      <ProviderHomeView
        providerLabel={provider?.company_name ?? pu.provider_id}
        greetingName={pu.display_name ?? pu.contact_email}
        enrolledLast30d={enrolledLast30d}
        counts={counts}
        callbackCount={callbackCount}
        fastrackReadyCount={fastrackReadyCount}
        staleAttemptCount={staleAttemptCount}
        oldestCallbackSince={oldestCallbackSince}
        oldestFastrackSince={oldestFastrackSince}
        oldestOpenSince={oldestOpenSince}
        oldestStaleAttemptSince={oldestStaleAttemptSince}
        recentLeads={recentLeads}
        sourceBreakdown={sourceBreakdown}
        leadsBase="/provider"
        leadDetailPrefix="/provider/leads/"
      />
    </ProviderShell>
  );
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
