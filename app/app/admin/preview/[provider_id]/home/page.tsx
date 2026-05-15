// /admin/preview/[provider_id]/home — read-only admin impersonation of
// the provider's home dashboard. Scoped to one provider via service-
// role queries (RLS would scope this for a real provider session;
// admin previews replicate that scoping manually).
//
// Reuses the presentational ProviderHomeView from /provider/home-view.tsx
// so the rendered output matches what a real provider sees pixel-for-
// pixel. All link targets (action queue, pipeline pills, "see all",
// lead-row clicks) stay inside the preview namespace so the operator
// keeps the PreviewHeader chrome and never gets bounced to the admin
// lead-detail surface.

import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminUser } from "@/lib/auth/require-admin";
import { ProviderHomeView } from "@/app/provider/home-view";
import type { LeadStatus } from "@/lib/lead-status";
import { PreviewHeader } from "../preview-header";

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

interface Props {
  params: Promise<{ provider_id: string }>;
}

export default async function PreviewHomePage({ params }: Props) {
  await requireAdminUser();
  const { provider_id: rawId } = await params;
  const providerId = decodeURIComponent(rawId);

  const admin = createAdminClient();

  // Provider basics + sheet existence flag (PreviewHeader needs is_demo).
  const { data: provider } = await admin
    .schema("crm")
    .from("providers")
    .select("provider_id, company_name, is_demo")
    .eq("provider_id", providerId)
    .maybeSingle<{ provider_id: string; company_name: string; is_demo: boolean }>();
  if (!provider) notFound();

  // Same fan-out as /provider/page.tsx but scoped manually to providerId
  // since we bypass RLS via the admin client.
  // Admin client bypasses RLS, so manually mirror the production
  // provider RLS policy (migration 0143): scope by primary_routed_to
  // AND exclude is_dq=true. Without the is_dq filter, preview shows
  // test rows the real provider never sees, defeating the purpose.
  const [enrolmentsRes, recentSubsRes, allRoutedRes, fastrackRes] = await Promise.all([
    admin
      .schema("crm")
      .from("enrolments")
      .select("submission_id, status, status_updated_at, callback_requested_at, submission:submissions!inner(is_dq)")
      .eq("provider_id", providerId)
      .eq("submission.is_dq", false),
    admin
      .schema("leads")
      .from("submissions")
      .select("id, first_name, last_name, email, course_id, routed_at")
      .eq("primary_routed_to", providerId)
      .not("is_dq", "is", true)
      .not("routed_at", "is", null)
      .is("archived_at", null)
      .is("parent_submission_id", null)
      .order("routed_at", { ascending: false })
      .limit(5),
    admin
      .schema("leads")
      .from("submissions")
      .select("id, routed_at, utm_source")
      .eq("primary_routed_to", providerId)
      .not("is_dq", "is", true)
      .not("routed_at", "is", null)
      .is("archived_at", null)
      .is("parent_submission_id", null),
    admin
      .schema("leads")
      .from("fastrack_submissions")
      .select("parent_submission_id, submitted_at, parent:submissions!inner(primary_routed_to, is_dq)")
      .eq("parent.primary_routed_to", providerId)
      .eq("parent.is_dq", false),
  ]);

  const enrolments = (enrolmentsRes.data ?? []) as EnrolmentCountRow[];
  const recentSubs = (recentSubsRes.data ?? []) as RecentLeadRow[];
  const recentIds = recentSubs.map((s) => s.id);
  const allRouted = (allRoutedRes.data ?? []) as RoutedIdRow[];
  const fastrackRows = (fastrackRes.data ?? []) as FastrackTimedRow[];

  // recent enrolments only needed for the 5 most-recent leads, separate
  // query because we want a specific submission_id IN list.
  const { data: recentEnrolsRaw } = recentIds.length
    ? await admin
        .schema("crm")
        .from("enrolments")
        .select("submission_id, status, status_updated_at")
        .eq("provider_id", providerId)
        .in("submission_id", recentIds)
    : { data: [] as RecentEnrolmentRow[] };
  const recentEnrolBySub = new Map<number, RecentEnrolmentRow>();
  for (const e of (recentEnrolsRaw ?? []) as RecentEnrolmentRow[]) {
    recentEnrolBySub.set(e.submission_id, e);
  }

  // Derived counts (mirrors /provider/page.tsx logic exactly).
  const counts = countByStatus(enrolments);
  const enrolledLast30d = enrolledLast30DaysCount(enrolments);
  const callbackCount = enrolments.filter((r) => r.callback_requested_at != null).length;

  const routedAtById = new Map<number, string | null>();
  for (const r of allRouted) routedAtById.set(r.id, r.routed_at);
  const allRoutedIds = new Set<number>(allRouted.map((r) => r.id));

  // Fastrack-ready excludes leads already at a settled outcome — matches
  // the bug fix on /provider/page.tsx for lead 375 (lost + fastrack
  // showing in "Needs your attention").
  const SETTLED_FOR_FASTRACK = new Set(["lost", "presumed_enrolled", "enrolled"]);
  const settledIds = new Set<number>(
    enrolments
      .filter((e) => SETTLED_FOR_FASTRACK.has(e.status))
      .map((e) => e.submission_id),
  );
  const fastrackParentIds = new Set<number>(fastrackRows.map((r) => r.parent_submission_id));
  const fastrackReadyIds = [...fastrackParentIds].filter(
    (id) => allRoutedIds.has(id) && !settledIds.has(id),
  );
  const fastrackReadyCount = fastrackReadyIds.length;

  const STALE_ATTEMPT_HOURS = 36;
  const staleAttemptCutoff = Date.now() - STALE_ATTEMPT_HOURS * 60 * 60 * 1000;
  const staleAttempts = enrolments.filter(
    (e) =>
      (e.status === "attempt_1_no_answer" ||
        e.status === "attempt_2_no_answer" ||
        e.status === "attempt_3_no_answer") &&
      new Date(e.status_updated_at).getTime() < staleAttemptCutoff,
  );
  const staleAttemptCount = staleAttempts.length;

  const oldestCallbackSince = oldestIso(
    enrolments
      .filter((e) => e.callback_requested_at != null)
      .map((e) => e.callback_requested_at as string),
  );
  const oldestFastrackSince = oldestIso(
    fastrackRows
      .filter(
        (r) => allRoutedIds.has(r.parent_submission_id)
          && !settledIds.has(r.parent_submission_id),
      )
      .map((r) => r.submitted_at),
  );
  const oldestOpenSince = oldestIso(
    enrolments
      .filter((e) => e.status === "open")
      .map((e) => routedAtById.get(e.submission_id) ?? null)
      .filter((v): v is string => v != null),
  );
  const oldestStaleAttemptSince = oldestIso(staleAttempts.map((e) => e.status_updated_at));

  // Overdue thresholds mirror /provider/page.tsx.
  const OVERDUE_OPEN_MS = 24 * 60 * 60 * 1000;
  const OVERDUE_36H_MS = 36 * 60 * 60 * 1000;
  const overdueOpen = isOlderThan(oldestOpenSince, OVERDUE_OPEN_MS);
  const overdueCallback = isOlderThan(oldestCallbackSince, OVERDUE_36H_MS);
  const overdueStaleAttempt = isOlderThan(oldestStaleAttemptSince, OVERDUE_36H_MS);
  const overdueFastrack = false;

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

  const encoded = encodeURIComponent(providerId);

  return (
    <>
      <PreviewHeader
        providerId={providerId}
        companyName={provider.company_name}
        isDemo={provider.is_demo}
        active="home"
      />
      <div className="bg-slate-50 min-h-screen">
        <ProviderHomeView
          providerLabel={provider.company_name}
          greetingName={provider.company_name}
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
          overdueFastrack={overdueFastrack}
          overdueCallback={overdueCallback}
          overdueOpen={overdueOpen}
          overdueStaleAttempt={overdueStaleAttempt}
          leadsBase={`/preview/${encoded}`}
          leadDetailPrefix={`/preview/${encoded}/leads/`}
        />
      </div>
    </>
  );
}

function countByStatus(rows: EnrolmentCountRow[]) {
  let open = 0;
  let attempts = 0;
  let meetingBooked = 0;
  for (const r of rows) {
    if (r.status === "open") open += 1;
    if (
      r.status === "attempt_1_no_answer" ||
      r.status === "attempt_2_no_answer" ||
      r.status === "attempt_3_no_answer"
    ) {
      attempts += 1;
    }
    if (r.status === "enrolment_meeting_booked") meetingBooked += 1;
  }
  return { open, attempts, meeting_booked: meetingBooked };
}

function enrolledLast30DaysCount(rows: EnrolmentCountRow[]): number {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return rows.filter(
    (r) =>
      (r.status === "enrolled" || r.status === "presumed_enrolled") &&
      new Date(r.status_updated_at).getTime() >= cutoff,
  ).length;
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

function isOlderThan(iso: string | null, thresholdMs: number): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() > thresholdMs;
}
