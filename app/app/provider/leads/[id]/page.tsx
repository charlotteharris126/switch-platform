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
import { DurationTimer } from "../../duration-timer";
import { OutcomeButtons } from "./outcome-buttons";
import { NotesEditor } from "./notes-editor";
import { markOutcomeAction, saveLeadNotesAction } from "./actions";
import { STATUS_LABEL, type LeadStatus } from "@/lib/lead-status";
import { formatIntakeId } from "@/lib/intake-format";

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
  preferred_intake_id: string | null;
  acceptable_intake_ids: string[] | null;
  start_when: string | null;
  start_timing: string | null;
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

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ProviderLeadDetailPage({ params }: Props) {
  const { id: idRaw } = await params;
  const submissionId = parseInt(idRaw, 10);
  if (Number.isNaN(submissionId)) notFound();

  const supabase = await createClient();
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session?.user) redirect("/passkey-login");

  // Submission + enrolment fetched in parallel — they only share the
  // submissionId from the URL, no inter-query dependency. RLS scopes both.
  const [submissionResult, enrolResult] = await Promise.all([
    supabase
      .schema("leads")
      .from("submissions")
      .select(
        "id,submitted_at,routed_at,primary_routed_to,first_name,last_name,email,phone,age_band,employment_status,course_id,funding_category,funding_route,prior_level_3_or_higher,can_start_on_intake_date,preferred_intake_id,acceptable_intake_ids,start_when,start_timing,outcome_interest,why_this_course,la,postcode,region,is_dq,dq_reason",
      )
      .eq("id", submissionId)
      .maybeSingle<SubmissionRow>(),
    supabase
      .schema("crm")
      .from("enrolments")
      .select("id,status,lost_reason,status_updated_at,notes")
      .eq("submission_id", submissionId)
      .maybeSingle<EnrolmentRow>(),
  ]);

  const submission = submissionResult.data;
  if (!submission) notFound();
  const enrol = enrolResult.data;

  const status = (enrol?.status ?? "open") as LeadStatus;

  return (
    <ProviderShell active="leads">
      <div className="max-w-3xl mx-auto p-6">
        <Link href="/provider/leads" className="text-sm text-slate-600 hover:text-slate-900 cursor-pointer">
          &larr; All leads
        </Link>

        <div className="mt-4">
          <h1 className="text-2xl font-semibold text-slate-900">
            {[submission.first_name, submission.last_name].filter(Boolean).join(" ") || submission.email || `Lead ${submission.id}`}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Current status: <strong className="text-slate-900">{STATUS_LABEL[status] ?? status}</strong>
          </p>
        </div>

        {/* Duration tiles */}
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs uppercase tracking-wide font-semibold text-slate-500">In your queue</p>
            <p className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
              <DurationTimer since={submission.routed_at} variant="full" />
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Routed {submission.routed_at ? new Date(submission.routed_at).toLocaleDateString("en-GB") : "—"}
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs uppercase tracking-wide font-semibold text-slate-500">At current status</p>
            <p className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
              <DurationTimer since={enrol?.status_updated_at ?? submission.routed_at} variant="full" />
            </p>
            <p className="text-xs text-slate-500 mt-1">
              {STATUS_LABEL[status] ?? status} since{" "}
              {enrol?.status_updated_at
                ? new Date(enrol.status_updated_at).toLocaleDateString("en-GB")
                : submission.routed_at
                  ? new Date(submission.routed_at).toLocaleDateString("en-GB")
                  : "—"}
            </p>
          </div>
        </div>

        {/* Outcome marking */}
        <div className="mt-6 bg-white border border-slate-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-slate-900">Mark outcome</h2>
          <p className="text-xs text-slate-500 mt-1">
            Click whichever applies. Forward only — once you&apos;ve moved past a step you can&apos;t go back. Every change is logged.
          </p>
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
            <Row label="Outcome they want" value={submission.outcome_interest} />
          </Section>

          <Section title="Course">
            <Row label="Course" value={submission.course_id} />
            <Row label="Funding" value={fundingLabel(submission.funding_category, submission.funding_route)} />
            <IntakeRow
              canStart={submission.can_start_on_intake_date}
              preferredIntakeId={submission.preferred_intake_id}
              acceptableIntakeIds={submission.acceptable_intake_ids}
              startWhen={submission.start_when}
              startTiming={submission.start_timing}
            />
          </Section>

          <Section title="In their words">
            <p className="text-sm text-slate-700 whitespace-pre-wrap">
              {submission.why_this_course || <span className="text-slate-400 italic">Nothing recorded.</span>}
            </p>
          </Section>
        </div>

        {/* Notes — editable by the provider */}
        <div className="mt-6 bg-white border border-slate-200 rounded-xl p-6">
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-slate-900">Your notes on this lead</h2>
            <p className="text-xs text-slate-500 mt-1">
              Private to your business. Visible to anyone on your team in the portal.
            </p>
          </div>
          <NotesEditor
            submissionId={submission.id}
            initialValue={enrol?.notes ?? ""}
            onSave={saveLeadNotesAction}
          />
        </div>
      </div>
    </ProviderShell>
  );
}

function IntakeRow({
  canStart,
  preferredIntakeId,
  acceptableIntakeIds,
  startWhen,
  startTiming,
}: {
  canStart: boolean | null;
  preferredIntakeId: string | null;
  acceptableIntakeIds: string[] | null;
  startWhen: string | null;
  startTiming: string | null;
}) {
  // Pre-routing / waitlist DQ leads have no intake answer; show their
  // start-timing instead so the provider knows when they want to start.
  if (canStart == null) {
    if (startTiming) return <Row label="Wants to start" value={humanise(startTiming)} />;
    if (startWhen) return <Row label="Wants to start" value={humanise(startWhen)} />;
    return <Row label="Can start on intake" value={null} />;
  }

  if (canStart === false) {
    return <Row label="Can start on intake" value="No" />;
  }

  // canStart === true: render a list of dates if we have them, otherwise a plain Yes.
  const ids = (acceptableIntakeIds ?? []).filter((s) => s && s.length > 0);
  if (ids.length === 0 && !preferredIntakeId) {
    return <Row label="Can start on intake" value="Yes" />;
  }

  // Single-intake course (or only one acceptable date)
  if (ids.length <= 1) {
    const onlyId = preferredIntakeId ?? ids[0] ?? null;
    return (
      <Row
        label="Can start on intake"
        value={onlyId ? `Yes — ${formatIntakeId(onlyId)}` : "Yes"}
      />
    );
  }

  // Multi-intake course — show all acceptable dates, mark preferred
  const sorted = [...ids].sort();
  return (
    <div className="text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-slate-500">Can start on intake</span>
        <span className="text-slate-900 font-medium">Yes — {sorted.length} dates</span>
      </div>
      <ul className="mt-1 ml-3 space-y-0.5">
        {sorted.map((id) => {
          const isPreferred = id === preferredIntakeId;
          return (
            <li key={id} className="text-xs text-slate-700 flex items-center gap-2">
              <span className="text-slate-400">•</span>
              <span>{formatIntakeId(id)}</span>
              {isPreferred && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-emerald-100 text-emerald-800 border border-emerald-200">
                  Preferred
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function humanise(snake: string): string {
  return snake.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
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
