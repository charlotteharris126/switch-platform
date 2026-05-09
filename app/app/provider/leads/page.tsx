// /provider/leads — list of routed leads for the authenticated provider.
//
// RLS is the trust boundary: the policies from migration 0096 scope
// leads.submissions and crm.enrolments to the caller's provider_id via
// the crm.provider_user_provider_id() helper. We query as the
// authenticated role (cookie-based session) so those policies fire.
// Service-role (admin) bypasses RLS and would leak cross-provider data —
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
import type { LeadStatus } from "@/lib/lead-status";

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
}

interface Props {
  searchParams: Promise<{ status?: string }>;
}

export default async function ProviderLeadsPage({ searchParams }: Props) {
  const { status: statusParam } = await searchParams;
  const initialFilter = parseFilter(statusParam);

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) redirect("/passkey-login");

  const { data: submissions, error: submissionsErr } = await supabase
    .schema("leads")
    .from("submissions")
    .select("id,first_name,last_name,email,course_id,funding_category,routed_at,re_submission_count")
    .not("routed_at", "is", null)
    .is("archived_at", null)
    .is("parent_submission_id", null)
    .order("routed_at", { ascending: false })
    .limit(200);

  const subs = (submissions ?? []) as SubmissionRow[];
  const ids = subs.map((s) => s.id);

  const { data: enrolments } = ids.length
    ? await supabase
        .schema("crm")
        .from("enrolments")
        .select("submission_id,status,lost_reason,status_updated_at")
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
    };
  });

  return (
    <ProviderShell active="leads">
      <div className="max-w-5xl mx-auto p-6">
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
          <LeadsTable rows={rows} initialFilter={initialFilter} />
        )}
      </div>
    </ProviderShell>
  );
}

function parseFilter(param: string | undefined): "all" | "open" | "in_progress" | "settled" | LeadStatus {
  if (!param) return "all";
  const normalised = param.toLowerCase();
  if (
    normalised === "all" ||
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
  return parts.length ? parts.join(" ") : (s.email ?? "—");
}
