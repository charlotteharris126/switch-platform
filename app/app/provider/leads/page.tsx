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

import { createClient } from "@/lib/supabase/server";
import { requireProviderUser } from "@/lib/auth/require-provider";
import { ProviderShell } from "../provider-shell";
import { LeadsTable, type LeadRow, type Filter } from "./leads-table";
import { LeadsSidebar } from "./leads-sidebar";
import type { LeadStatus } from "@/lib/lead-status";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { bulkMarkOutcomeAction } from "./[id]/actions";

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
  preferred_intake_id: string | null;
  acceptable_intake_ids: string[] | null;
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

  const ctx = await requireProviderUser();
  const supabase = await createClient();

  const [submissionsResult, fastrackResult] = await Promise.all([
    supabase
      .schema("leads")
      .from("submissions")
      .select("id,first_name,last_name,email,course_id,funding_category,routed_at,re_submission_count,preferred_intake_id,acceptable_intake_ids")
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
      status_updated_at: enrol?.status_updated_at ?? null,
      has_fastrack: fastrackParentIds.has(s.id),
      callback_pending: enrol?.callback_requested_at != null,
      preferred_intake_id: s.preferred_intake_id,
      acceptable_intake_ids: s.acceptable_intake_ids,
    };
  });

  // Sidebar derived data — all from already-loaded rows, no extra round-trips.
  // Categories mirror the filter pills 1:1 so a click in the sidebar lands on
  // a list view with the same count.
  const now = Date.now();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const weekStart = now - 7 * DAY;

  const CALLING_STATUSES = new Set<LeadStatus>([
    "attempt_1_no_answer",
    "attempt_2_no_answer",
    "attempt_3_no_answer",
  ]);

  let openCount = 0;
  let callingCount = 0;
  let meetingBookedCount = 0;
  let enrolledThisMonth = 0;
  let callbackPendingCount = 0;
  let weekContacted = 0;
  let weekEnrolled = 0;
  let weekLost = 0;
  let weekMeetingsBooked = 0;
  for (const r of rows) {
    if (r.status === "open") openCount += 1;
    if (CALLING_STATUSES.has(r.status)) callingCount += 1;
    if (r.status === "enrolment_meeting_booked") meetingBookedCount += 1;
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

  return (
    <ProviderShell active="leads">
      <RealtimeRefresh
        channel={`rt-provider-leads-${ctx.providerId}`}
        tables={[
          { schema: "leads", table: "submissions", filter: `primary_routed_to=eq.${ctx.providerId}` },
          { schema: "crm", table: "enrolments", filter: `provider_id=eq.${ctx.providerId}` },
          { schema: "crm", table: "lead_notes", filter: `provider_id=eq.${ctx.providerId}` },
        ]}
      />
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
              <LeadsTable
                key={initialFilter}
                rows={rows}
                initialFilter={initialFilter}
                onBulkMark={bulkMarkOutcomeAction}
              />
            </div>
            <div className="lg:col-span-1 lg:sticky lg:top-6">
              <LeadsSidebar
                open={openCount}
                calling={callingCount}
                meetingBooked={meetingBookedCount}
                enrolledThisMonth={enrolledThisMonth}
                callbackPending={callbackPendingCount}
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

function parseFilter(param: string | undefined): Filter {
  if (!param) return "all";
  const normalised = param.toLowerCase();
  // Map old aliases that may still be on home-page tile links into the new shape.
  if (normalised === "in_progress") return "calling";
  if (normalised === "settled") return "enrolled";
  if (normalised === "enrolment_meeting_booked") return "meeting";
  if (
    normalised === "all" ||
    normalised === "action" ||
    normalised === "callback" ||
    normalised === "fastrack" ||
    normalised === "open" ||
    normalised === "calling" ||
    normalised === "meeting" ||
    normalised === "enrolled" ||
    normalised === "cold" ||
    normalised === "stale_attempts"
  ) {
    return normalised;
  }
  return "all";
}

function fullName(s: SubmissionRow): string {
  const parts = [s.first_name, s.last_name].filter(Boolean);
  return parts.length ? parts.join(" ") : (s.email ?? "-");
}
