// /provider/leads. list of routed leads for the authenticated provider.
//
// RLS is the trust boundary: the policies from migration 0096 scope
// leads.submissions and crm.enrolments to the caller's provider_id via
// the crm.provider_user_provider_id() helper. We query as the
// authenticated role (cookie-based session) so those policies fire.
// Service-role (admin) bypasses RLS and would leak cross-provider data -
// never use it on this page.
//
// Filtering and search happen client-side on already-loaded rows; the
// LeadsTable client component handles UI state. The status query param
// (e.g. /provider/leads?status=open) seeds the initial filter so home
// page tiles deep-link into the right view.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProviderShell } from "../provider-shell";
import { LeadsTable, type LeadRow } from "./leads-table";
import { LeadsSidebar } from "./leads-sidebar";
import type { LeadStatus } from "@/lib/lead-status";

const IN_PROGRESS_STATUSES = new Set<LeadStatus>([
  "attempt_1_no_answer",
  "attempt_2_no_answer",
  "attempt_3_no_answer",
  "enrolment_meeting_booked",
]);
const CONTACTED_STATUSES = new Set<LeadStatus>([
  "attempt_1_no_answer",
  "attempt_2_no_answer",
  "attempt_3_no_answer",
  "enrolment_meeting_booked",
  "enrolled",
  "presumed_enrolled",
  "lost",
  "cannot_reach",
]);

const DAY = 24 * 60 * 60 * 1000;

interface SubmissionRow {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  course_id: string | null;
  funding_category: string | null;
  routed_at: string | null;
  re_submission_count: number | null;
}

interface EnrolmentRow {
  submission_id: number;
  status: string;
  lost_reason: string | null;
  status_updated_at: string;
  callback_requested_at: string | null;
}

interface Props {
  searchParams: Promise<{ status?: string }>;
}

export default async function ProviderLeadsPage({ searchParams }: Props) {
  const { status: statusParam } = await searchParams;
  const initialFilter = parseFilter(statusParam);

  const supabase = await createClient();
  // Cookie-only session check; the proxy already validated against the
  // Supabase Auth API, RLS gates every query.
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session?.user) redirect("/passkey-login");

  const [submissionsResult, fastrackResult] = await Promise.all([
    supabase
      .schema("leads")
      .from("submissions")
      .select("id,first_name,last_name,email,course_id,funding_category,routed_at,re_submission_count")
      .not("routed_at", "is", null)
      .is("archived_at", null)
      .is("parent_submission_id", null)
      .order("routed_at", { ascending: false })
      .limit(200),
    supabase
      .schema("leads")
      .from("fastrack_submissions")
      .select("parent_submission_id"),
  ]);

  const submissions = submissionsResult.data;
  const submissionsErr = submissionsResult.error;

  const subs = (submissions ?? []) as SubmissionRow[];
  const ids = subs.map((s) => s.id);
  const fastrackParentIds = new Set<number>(
    (fastrackResult.data ?? []).map((r: { parent_submission_id: number }) => r.parent_submission_id),
  );

  const { data: enrolments } = ids.length
    ? await supabase
        .schema("crm")
        .from("enrolments")
        .select("submission_id,status,lost_reason,status_updated_at,callback_requested_at")
        .in("submission_id", ids)
    : { data: [] as EnrolmentRow[] };

  const enrolBySub = new Map<number, EnrolmentRow>();
  for (const e of (enrolments ?? []) as EnrolmentRow[]) {
    enrolBySub.set(e.submission_id, e);
  }

  const rows: LeadRow[] = subs.map((s) => {
    const enrol = enrolBySub.get(s.id);
    return {
      id: s.id,
      name: fullName(s),
      email: s.email,
      course_id: s.course_id,
      funding_category: s.funding_category,
      routed_at: s.routed_at,
      status: (enrol?.status ?? "open") as LeadStatus,
      has_fastrack: fastrackParentIds.has(s.id),
      callback_pending: enrol?.callback_requested_at != null,
    };
  });

  // Sidebar derived data. all from already-loaded rows, no extra round-trips.
  const now = Date.now();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const weekStart = now - 7 * DAY;
  const sevenDaysAgo = now - 7 * DAY;

  let openCount = 0;
  let inProgressCount = 0;
  let enrolledThisMonth = 0;
  let callbackPendingCount = 0;
  let weekContacted = 0;
  let weekEnrolled = 0;
  let weekLost = 0;
  let weekMeetingsBooked = 0;
  for (const r of rows) {
    if (r.status === "open") openCount += 1;
    if (IN_PROGRESS_STATUSES.has(r.status)) inProgressCount += 1;
    if (r.callback_pending) callbackPendingCount += 1;
    const enrol = enrolBySub.get(r.id);
    if (enrol) {
      const t = new Date(enrol.status_updated_at).getTime();
      if ((enrol.status === "enrolled" || enrol.status === "presumed_enrolled") && t >= monthStart) {
        enrolledThisMonth += 1;
      }
      if (t >= weekStart) {
        if (CONTACTED_STATUSES.has(enrol.status as LeadStatus)) weekContacted += 1;
        if (enrol.status === "enrolled") weekEnrolled += 1;
        if (enrol.status === "lost") weekLost += 1;
        if (enrol.status === "enrolment_meeting_booked") weekMeetingsBooked += 1;
      }
    }
  }

  // Stale leads = open + routed_at older than 7 days. Top 5 by oldest first.
  const staleLeads = rows
    .filter((r) => r.status === "open" && r.routed_at && new Date(r.routed_at).getTime() < sevenDaysAgo)
    .sort((a, b) => new Date(a.routed_at!).getTime() - new Date(b.routed_at!).getTime())
    .slice(0, 5)
    .map((r) => ({ id: r.id, name: r.name, routed_at: r.routed_at, status: r.status }));

  return (
    <ProviderShell active="leads">
      <div className="max-w-7xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">Your leads</h1>
          <p className="text-sm text-slate-500 mt-1">
            {submissionsErr ? (
              <span className="text-rose-600">Error: {submissionsErr.message}</span>
            ) : (
              `${rows.length} routed lead${rows.length === 1 ? "" : "s"}, most recent first.`
            )}
          </p>
        </div>

        {rows.length === 0 ? (
          <div className="text-center py-16 text-slate-500 text-sm bg-white border border-slate-200 rounded-xl">
            No leads routed to you yet. New leads will appear here as they come in.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start">
            <div className="lg:col-span-3">
              <LeadsTable rows={rows} initialFilter={initialFilter} />
            </div>
            <div className="lg:col-span-1 lg:sticky lg:top-6">
              <LeadsSidebar
                open={openCount}
                inProgress={inProgressCount}
                enrolledThisMonth={enrolledThisMonth}
                callbackPending={callbackPendingCount}
                staleLeads={staleLeads}
                weekStats={{
                  contacted: weekContacted,
                  enrolled: weekEnrolled,
                  lost: weekLost,
                  meetings_booked: weekMeetingsBooked,
                }}
              />
            </div>
          </div>
        )}
      </div>
    </ProviderShell>
  );
}

function parseFilter(param: string | undefined): "all" | "callback" | "open" | "in_progress" | "settled" | LeadStatus {
  if (!param) return "all";
  const normalised = param.toLowerCase();
  if (
    normalised === "all" ||
    normalised === "callback" ||
    normalised === "open" ||
    normalised === "in_progress" ||
    normalised === "settled"
  ) {
    return normalised;
  }
  // Direct status filter (e.g. ?status=enrolled)
  if (
    [
      "attempt_1_no_answer",
      "attempt_2_no_answer",
      "attempt_3_no_answer",
      "enrolment_meeting_booked",
      "enrolled",
      "presumed_enrolled",
      "lost",
      "cannot_reach",
    ].includes(normalised)
  ) {
    return normalised as LeadStatus;
  }
  return "all";
}

function fullName(s: SubmissionRow): string {
  const parts = [s.first_name, s.last_name].filter(Boolean);
  return parts.length ? parts.join(" ") : (s.email ?? "-");
}
