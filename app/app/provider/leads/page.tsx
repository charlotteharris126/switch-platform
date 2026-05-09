// /provider/leads — list of routed leads for the authenticated provider.
//
// RLS is the trust boundary: the policies from migration 0096 scope
// leads.submissions and crm.enrolments to the caller's provider_id via
// the crm.provider_user_provider_id() helper. We query as the
// authenticated role (cookie-based session) so those policies fire.
// Service-role (admin) bypasses RLS and would leak cross-provider data —
// never use it on this page.

import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProviderShell } from "../provider-shell";

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

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  attempt_1_no_answer: "1st no answer",
  attempt_2_no_answer: "2nd no answer",
  attempt_3_no_answer: "3rd no answer",
  enrolment_meeting_booked: "Meeting booked",
  enrolled: "Enrolled",
  presumed_enrolled: "Presumed enrolled",
  lost: "Lost",
  cannot_reach: "Cannot reach",
};

const STATUS_TONE: Record<string, string> = {
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

function daysAgo(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function fullName(s: SubmissionRow): string {
  const parts = [s.first_name, s.last_name].filter(Boolean);
  return parts.length ? parts.join(" ") : (s.email ?? "—");
}

export default async function ProviderLeadsPage() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) redirect("/passkey-login");

  // Submissions — RLS scopes by primary_routed_to = caller's provider_id.
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

  // Enrolments — RLS scopes the same way.
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

  return (
    <ProviderShell active="leads">
      <div className="max-w-5xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">Your leads</h1>
          <p className="text-sm text-slate-500 mt-1">
            {submissionsErr ? (
              <span className="text-rose-600">Error: {submissionsErr.message}</span>
            ) : (
              `${subs.length} routed lead${subs.length === 1 ? "" : "s"}, most recent first.`
            )}
          </p>
        </div>

        {subs.length === 0 ? (
          <div className="text-center py-16 text-slate-500 text-sm">
            No leads routed to you yet. New leads will appear here as they come in.
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold">Name</th>
                  <th className="text-left px-4 py-3 font-semibold">Course</th>
                  <th className="text-left px-4 py-3 font-semibold">Routed</th>
                  <th className="text-left px-4 py-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {subs.map((s) => {
                  const enrol = enrolBySub.get(s.id);
                  const status = enrol?.status ?? "open";
                  const days = daysAgo(s.routed_at);
                  return (
                    <tr key={s.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3">
                        <Link href={`/provider/leads/${s.id}`} className="text-slate-900 font-medium hover:underline">
                          {fullName(s)}
                        </Link>
                        {s.email && (
                          <div className="text-xs text-slate-500">{s.email}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {s.course_id ?? "—"}
                        {s.funding_category && (
                          <div className="text-xs text-slate-500">
                            {s.funding_category === "gov" ? "Funded" : s.funding_category === "self" ? "Self-funded" : s.funding_category}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {days === null ? "—" : days === 0 ? "Today" : `${days} day${days === 1 ? "" : "s"} ago`}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${STATUS_TONE[status] ?? "bg-slate-100 text-slate-700 border-slate-200"}`}>
                          {STATUS_LABEL[status] ?? status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </ProviderShell>
  );
}
