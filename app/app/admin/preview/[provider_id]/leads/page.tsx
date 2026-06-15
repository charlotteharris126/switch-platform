// /admin/preview/[provider_id]/leads — read-only admin impersonation of
// /provider/leads scoped to the target provider.
//
// Why this exists: before flipping a real provider's `portal_enabled=true`
// and sending them a passkey invite, Charlotte wants to see exactly what
// their leads view would look like with their real routed-lead data. The
// alternative — seeding `provider_users`, sending herself an invite,
// signing in as them — pollutes the audit log and gets confusing fast.
// This page renders the same UI from the same Supabase tables, scoped
// the way RLS would scope them for a real provider session.
//
// Scoping happens manually here (service-role client + explicit
// `.eq("primary_routed_to", providerId)`), mirroring the RLS policies in
// migration 0096. Whenever the provider-side query in /provider/leads
// changes, mirror the change here too.
//
// Read-only is enforced by not passing `onBulkMark` to LeadsTable, so
// the select column and BulkBar never render. Lead-name clicks stay
// inside the preview namespace and land on
// /preview/<provider_id>/leads/<lead_id> via the `linkPrefix` prop, so
// the PreviewHeader chrome is preserved and outcome controls hide.

import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminUser } from "@/lib/auth/require-admin";
import { LeadsTable, type LeadRow, type Filter } from "@/app/provider/leads/leads-table";
import { LeadsSidebar } from "@/app/provider/leads/leads-sidebar";
import type { LeadStatus } from "@/lib/lead-status";
import { PreviewHeader } from "../preview-header";

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
  pay_route: string | null;
  routed_at: string | null;
  re_submission_count: number | null;
  preferred_intake_id: string | null;
  acceptable_intake_ids: string[] | null;
  lead_type: "learner" | "employer_apprenticeship" | null;
  company_name: string | null;
  role_title: string | null;
  sector: string | null;
  region: string | null;
  la: string | null;
}

interface EnrolmentRow {
  submission_id: number;
  status: string;
  lost_reason: string | null;
  status_updated_at: string;
  callback_requested_at: string | null;
}

interface Props {
  params: Promise<{ provider_id: string }>;
  searchParams: Promise<{ status?: string }>;
}

export default async function PreviewLeadsPage({ params, searchParams }: Props) {
  await requireAdminUser();
  const { provider_id: rawId } = await params;
  const providerId = decodeURIComponent(rawId);
  const { status: statusParam } = await searchParams;
  const initialFilter = parseFilter(statusParam);

  const admin = createAdminClient();

  const { data: provider } = await admin
    .schema("crm")
    .from("providers")
    .select("provider_id, company_name, is_demo")
    .eq("provider_id", providerId)
    .maybeSingle<{ provider_id: string; company_name: string; is_demo: boolean }>();
  if (!provider) notFound();

  // Match /provider/leads/page.tsx query shape exactly, but manually
  // scope to this provider via primary_routed_to instead of relying on
  // RLS (admin client bypasses RLS). The is_dq filter mirrors the
  // production RLS policy (migration 0143, widened in 0210) — preview must
  // hide test rows the same way the real portal does, while still showing
  // private-pay leads (is_dq=true but pay_route='private'), which route to
  // the provider as a paying enrolment.
  const submissionsResult = await admin
    .schema("leads")
    .from("submissions")
    .select("id,first_name,last_name,email,course_id,funding_category,pay_route,routed_at,re_submission_count,preferred_intake_id,acceptable_intake_ids,lead_type,company_name,role_title,sector,region,la")
    .eq("primary_routed_to", providerId)
    .or("is_dq.not.is.true,pay_route.eq.private")
    .not("routed_at", "is", null)
    .is("archived_at", null)
    .is("parent_submission_id", null)
    .order("routed_at", { ascending: false })
    .limit(200);

  const submissions = submissionsResult.data;
  const submissionsErr = submissionsResult.error;

  const subs = (submissions ?? []) as SubmissionRow[];
  const ids = subs.map((s) => s.id);

  // Fastrack flags: scoped to the parent submissions we already loaded.
  const fastrackResult = ids.length
    ? await admin
        .schema("leads")
        .from("fastrack_submissions")
        .select("parent_submission_id")
        .in("parent_submission_id", ids)
    : { data: [] as Array<{ parent_submission_id: number }> };
  const fastrackParentIds = new Set<number>(
    (fastrackResult.data ?? []).map((r: { parent_submission_id: number }) => r.parent_submission_id),
  );

  const { data: enrolments } = ids.length
    ? await admin
        .schema("crm")
        .from("enrolments")
        .select("submission_id,status,lost_reason,status_updated_at,callback_requested_at")
        .in("submission_id", ids)
    : { data: [] as EnrolmentRow[] };

  // Canonical open intakes — mirrors the real-provider /provider/leads
  // query so admin preview shows the same cohort filter options.
  const { data: courseIntakesData } = await admin
    .schema("crm")
    .from("course_intakes")
    .select("course_slug, intake_id")
    .eq("status", "open");
  const courseSlugsInRows = new Set<string | null>(subs.map((s) => s.course_id));
  const seededIntakeIds = ((courseIntakesData ?? []) as Array<{ course_slug: string; intake_id: string }>)
    .filter((r) => courseSlugsInRows.has(r.course_slug))
    .map((r) => r.intake_id);

  const enrolBySub = new Map<number, EnrolmentRow>();
  for (const e of (enrolments ?? []) as EnrolmentRow[]) {
    enrolBySub.set(e.submission_id, e);
  }

  // Re-application timestamps (mirrors /provider/leads/page.tsx): latest child
  // submission per parent, for the Re-applied badge recency + list bubbling.
  const { data: reapplyRows } = ids.length
    ? await admin
        .schema("leads")
        .from("submissions")
        .select("parent_submission_id,created_at")
        .in("parent_submission_id", ids)
    : { data: [] as Array<{ parent_submission_id: number; created_at: string }> };
  const lastReapplyBySub = new Map<number, string>();
  for (const r of (reapplyRows ?? []) as Array<{ parent_submission_id: number; created_at: string }>) {
    const prev = lastReapplyBySub.get(r.parent_submission_id);
    if (!prev || r.created_at > prev) lastReapplyBySub.set(r.parent_submission_id, r.created_at);
  }

  const rows: LeadRow[] = subs.map((s) => {
    const enrol = enrolBySub.get(s.id);
    return {
      id: s.id,
      name: fullName(s),
      email: s.email,
      course_id: s.course_id,
      funding_category: s.funding_category,
      pay_route: s.pay_route,
      routed_at: s.routed_at,
      status: (enrol?.status ?? "open") as LeadStatus,
      status_updated_at: enrol?.status_updated_at ?? null,
      has_fastrack: fastrackParentIds.has(s.id),
      callback_pending: enrol?.callback_requested_at != null,
      re_submission_count: s.re_submission_count ?? 0,
      re_submitted_at: lastReapplyBySub.get(s.id) ?? null,
      lead_type: s.lead_type ?? "learner",
      preferred_intake_id: s.preferred_intake_id,
      acceptable_intake_ids: s.acceptable_intake_ids,
      company_name: s.company_name,
      role_title: s.role_title,
      sector: s.sector,
      region: s.region,
      la: s.la,
    };
  });

  // Sidebar counts (mirrors /provider/leads/page.tsx).
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
    <>
      <PreviewHeader
        providerId={providerId}
        companyName={provider.company_name}
        isDemo={provider.is_demo}
        active="leads"
      />
      <div className="bg-slate-50 min-h-screen">
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
              No leads routed to {provider.company_name} yet. They&apos;d see this empty state in their portal.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start">
              <div className="lg:col-span-3">
                <LeadsTable
                  key={initialFilter}
                  rows={rows}
                  initialFilter={initialFilter}
                  linkPrefix={`/preview/${encodeURIComponent(providerId)}/leads/`}
                  seededCohortIds={seededIntakeIds}
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
                  leadsHrefBase={`/admin/preview/${encodeURIComponent(providerId)}/leads`}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function parseFilter(param: string | undefined): Filter {
  if (!param) return "all";
  const normalised = param.toLowerCase();
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
    normalised === "stale_attempts" ||
    normalised === "engaged" ||
    normalised === "in_progress" ||
    normalised === "signed" ||
    normalised === "not_signed" ||
    normalised === "near_60_day"
  ) {
    return normalised;
  }
  return "all";
}

function fullName(s: SubmissionRow): string {
  const parts = [s.first_name, s.last_name].filter(Boolean);
  return parts.length ? parts.join(" ") : (s.email ?? "-");
}
