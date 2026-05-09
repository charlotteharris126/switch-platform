// /provider/leads/[id] — lead detail + outcome marking.
//
// All routed payload fields are visible to the provider (RLS-scoped to
// their primary_routed_to). The OutcomeButtons client component fires
// markOutcomeAction (Server Action below) which writes crm.enrolments.status
// and audit-logs the change. Authenticated client throughout, RLS the
// trust boundary.

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ProviderShell } from "../../provider-shell";
import { OutcomeButtons } from "./outcome-buttons";
import { markOutcomeAction } from "./actions";

interface SubmissionRow {
  id: number;
  submitted_at: string;
  routed_at: string | null;
  primary_routed_to: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  age_band: string | null;
  employment_status: string | null;
  course_id: string | null;
  funding_category: string | null;
  funding_route: string | null;
  prior_level_3_or_higher: boolean | null;
  can_start_on_intake_date: boolean | null;
  outcome_interest: string | null;
  why_this_course: string | null;
  la: string | null;
  postcode: string | null;
  region: string | null;
  is_dq: boolean;
  dq_reason: string | null;
}

interface EnrolmentRow {
  id: number;
  status: string;
  lost_reason: string | null;
  status_updated_at: string;
  notes: string | null;
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

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ProviderLeadDetailPage({ params }: Props) {
  const { id: idRaw } = await params;
  const submissionId = parseInt(idRaw, 10);
  if (Number.isNaN(submissionId)) notFound();

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) redirect("/passkey-login");

  // RLS scopes by primary_routed_to. If the lead isn't theirs, this returns null.
  const { data: submission } = await supabase
    .schema("leads")
    .from("submissions")
    .select(
      "id,submitted_at,routed_at,primary_routed_to,first_name,last_name,email,phone,age_band,employment_status,course_id,funding_category,funding_route,prior_level_3_or_higher,can_start_on_intake_date,outcome_interest,why_this_course,la,postcode,region,is_dq,dq_reason",
    )
    .eq("id", submissionId)
    .maybeSingle<SubmissionRow>();

  if (!submission) notFound();

  const { data: enrol } = await supabase
    .schema("crm")
    .from("enrolments")
    .select("id,status,lost_reason,status_updated_at,notes")
    .eq("submission_id", submissionId)
    .maybeSingle<EnrolmentRow>();

  const status = enrol?.status ?? "open";

  return (
    <ProviderShell active="leads">
      <div className="max-w-3xl mx-auto p-6">
        <Link href="/provider/leads" className="text-sm text-slate-600 hover:text-slate-900">
          &larr; All leads
        </Link>

        <div className="mt-4">
          <h1 className="text-2xl font-semibold text-slate-900">
            {[submission.first_name, submission.last_name].filter(Boolean).join(" ") || submission.email || `Lead ${submission.id}`}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Routed {submission.routed_at ? new Date(submission.routed_at).toLocaleDateString("en-GB") : "—"} · Current status: <strong>{STATUS_LABEL[status] ?? status}</strong>
          </p>
        </div>

        {/* Outcome marking */}
        <div className="mt-6 bg-white border border-slate-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-slate-900">Mark outcome</h2>
          <p className="text-xs text-slate-500 mt-1">Click whichever applies. You can change your mind later — every change is logged.</p>
          <OutcomeButtons
            submissionId={submission.id}
            currentStatus={status}
            onMark={markOutcomeAction}
          />
        </div>

        {/* Contact + lead details */}
        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Section title="Contact">
            <Row label="Email" value={submission.email} />
            <Row label="Phone" value={submission.phone} />
            <Row label="Local authority" value={submission.la} />
            <Row label="Postcode" value={submission.postcode} />
            <Row label="Region" value={submission.region} />
          </Section>

          <Section title="About the learner">
            <Row label="Age band" value={submission.age_band} />
            <Row label="Employment" value={submission.employment_status} />
            <Row label="Has L3+" value={booleanLabel(submission.prior_level_3_or_higher)} />
            <Row label="Can start on intake" value={booleanLabel(submission.can_start_on_intake_date)} />
            <Row label="Outcome they want" value={submission.outcome_interest} />
          </Section>

          <Section title="Course">
            <Row label="Course" value={submission.course_id} />
            <Row label="Funding" value={fundingLabel(submission.funding_category, submission.funding_route)} />
          </Section>

          <Section title="In their words">
            <p className="text-sm text-slate-700 whitespace-pre-wrap">
              {submission.why_this_course || <span className="text-slate-400 italic">Nothing recorded.</span>}
            </p>
          </Section>
        </div>

        {enrol?.notes && (
          <div className="mt-6 bg-amber-50 border border-amber-200 rounded-xl p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">Notes</p>
            <p className="text-sm text-amber-900 mt-1 whitespace-pre-wrap">{enrol.notes}</p>
          </div>
        )}
      </div>
    </ProviderShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      <div className="mt-2 space-y-1">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-900 text-right">{value || <span className="text-slate-400">—</span>}</span>
    </div>
  );
}

function booleanLabel(v: boolean | null): string | null {
  if (v === true) return "Yes";
  if (v === false) return "No";
  return null;
}

function fundingLabel(cat: string | null, route: string | null): string | null {
  if (cat === "gov") return route ? `Funded (${route})` : "Funded";
  if (cat === "self") return "Self-funded";
  return cat ?? null;
}
