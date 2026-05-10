// /provider/leads/[id] — lead detail + outcome marking + notes log.
//
// All routed payload fields are visible to the provider (RLS-scoped to
// their primary_routed_to). Two-column layout: left = lead context +
// outcomes, right = notes log. Header carries prev/next navigation
// across the same ordering the leads list uses (fastrack pinned, then
// routed_at desc).

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ProviderShell } from "../../provider-shell";
import { DurationTimer } from "../../duration-timer";
import { OutcomeButtons } from "./outcome-buttons";
import { NotesLog, type NoteRow } from "./notes-log";
import { markOutcomeAction, addLeadNoteAction } from "./actions";
import { STATUS_LABEL, type LeadStatus } from "@/lib/lead-status";
import { formatIntakeId } from "@/lib/intake-format";
import {
  labelAgeBand,
  labelCourse,
  labelEmployment,
  labelFunding,
  labelOutcomeInterest,
  labelStartTiming,
} from "@/lib/lead-values";

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
}

interface NoteAuthor {
  display_name: string | null;
  contact_email: string;
}

interface NoteJoinRow {
  id: number;
  body: string;
  created_at: string;
  // supabase-js types embedded relations as array even for many-to-one
  provider_users: NoteAuthor | NoteAuthor[] | null;
}

interface SiblingRow {
  id: number;
  routed_at: string | null;
}

interface FastrackRow {
  parent_submission_id: number;
}

interface FastrackDetailRow {
  id: number;
  submitted_at: string;
  cohort_confirmed: boolean;
  transport_help_requested: boolean;
  docs_ready: boolean;
  l3_reconfirmed: boolean;
  l3_mismatch_flag: boolean;
  voice_of_learner_intro: string | null;
  terms_accepted: boolean;
  marketing_opt_in: boolean;
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

  // Fetch in one wave: this submission, this enrolment, notes for this
  // lead, all routed siblings (id + routed_at), all fastrack parent ids
  // for prev/next ordering, plus this lead's own fastrack row if any.
  // RLS-scoped throughout.
  const [
    submissionResult,
    enrolResult,
    notesResult,
    siblingsResult,
    fastrackResult,
    fastrackDetailResult,
  ] = await Promise.all([
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
      .select("id,status,lost_reason,status_updated_at")
      .eq("submission_id", submissionId)
      .maybeSingle<EnrolmentRow>(),
    supabase
      .schema("crm")
      .from("lead_notes")
      .select("id, body, created_at, provider_users:provider_user_id(display_name, contact_email)")
      .eq("submission_id", submissionId)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .schema("leads")
      .from("submissions")
      .select("id,routed_at")
      .not("routed_at", "is", null)
      .is("archived_at", null)
      .is("parent_submission_id", null)
      .order("routed_at", { ascending: false })
      .limit(500),
    supabase
      .schema("leads")
      .from("fastrack_submissions")
      .select("parent_submission_id"),
    supabase
      .schema("leads")
      .from("fastrack_submissions")
      .select(
        "id, submitted_at, cohort_confirmed, transport_help_requested, docs_ready, l3_reconfirmed, l3_mismatch_flag, voice_of_learner_intro, terms_accepted, marketing_opt_in",
      )
      .eq("parent_submission_id", submissionId)
      .order("submitted_at", { ascending: false })
      .limit(1)
      .maybeSingle<FastrackDetailRow>(),
  ]);

  const submission = submissionResult.data;
  if (!submission) notFound();
  const enrol = enrolResult.data;
  const status = (enrol?.status ?? "open") as LeadStatus;

  const fastrackParentIds = new Set<number>(
    (fastrackResult.data ?? []).map((r: FastrackRow) => r.parent_submission_id),
  );
  const hasFastrack = fastrackParentIds.has(submission.id);
  const fastrackDetail = fastrackDetailResult.data;

  // Build the same ordering the leads list uses: fastrack first, then
  // routed_at desc.
  const siblings = (siblingsResult.data ?? []) as SiblingRow[];
  siblings.sort((a, b) => {
    const aFast = fastrackParentIds.has(a.id) ? 1 : 0;
    const bFast = fastrackParentIds.has(b.id) ? 1 : 0;
    if (aFast !== bFast) return bFast - aFast;
    const aT = a.routed_at ? new Date(a.routed_at).getTime() : 0;
    const bT = b.routed_at ? new Date(b.routed_at).getTime() : 0;
    return bT - aT;
  });
  const idx = siblings.findIndex((s) => s.id === submission.id);
  const prevId = idx > 0 ? siblings[idx - 1].id : null;
  const nextId = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1].id : null;

  const noteRowsRaw = (notesResult.data ?? []) as unknown as NoteJoinRow[];
  const notes: NoteRow[] = noteRowsRaw.map((n) => {
    const author = Array.isArray(n.provider_users)
      ? n.provider_users[0] ?? null
      : n.provider_users;
    return {
      id: n.id,
      body: n.body,
      created_at: n.created_at,
      author: author?.display_name ?? author?.contact_email ?? "Someone",
    };
  });

  return (
    <ProviderShell active="leads">
      <div className="max-w-7xl mx-auto p-6">
        {/* Header row: back link + prev/next */}
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/provider/leads"
            className="text-sm text-slate-600 hover:text-slate-900 cursor-pointer"
          >
            &larr; All leads
          </Link>
          <div className="flex items-center gap-1 text-sm">
            <span className="text-xs text-slate-500 mr-2">
              {idx >= 0 ? `${idx + 1} of ${siblings.length}` : ""}
            </span>
            <NavButton href={prevId ? `/provider/leads/${prevId}` : null} label="Previous" direction="prev" />
            <NavButton href={nextId ? `/provider/leads/${nextId}` : null} label="Next" direction="next" />
          </div>
        </div>

        {/* Title */}
        <div className="mt-4 flex items-baseline gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold text-slate-900">
            {[submission.first_name, submission.last_name].filter(Boolean).join(" ") ||
              submission.email ||
              `Lead ${submission.id}`}
          </h1>
          {hasFastrack && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold bg-violet-100 text-violet-800 border border-violet-200">
              Fastrack submitted
            </span>
          )}
        </div>
        <p className="text-sm text-slate-500 mt-1">
          Current status: <strong className="text-slate-900">{STATUS_LABEL[status] ?? status}</strong>
        </p>

        {/* Two-column main */}
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* LEFT: lead context + outcome (spans 2 of 3 cols) */}
          <div className="lg:col-span-2 space-y-6">
            {/* Duration tiles */}
            <div className="grid grid-cols-2 gap-3">
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
            <div className="bg-white border border-slate-200 rounded-xl p-6">
              <h2 className="text-sm font-semibold text-slate-900">Mark outcome</h2>
              <p className="text-xs text-slate-500 mt-1">
                Click whichever applies. Forward only — once you&apos;ve moved past a step you can&apos;t go back.
                Every change is logged.
              </p>
              <OutcomeButtons
                submissionId={submission.id}
                currentStatus={status}
                onMark={markOutcomeAction}
              />
            </div>

            {/* Lead detail cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Section title="Contact">
                <Row label="Email" value={submission.email} />
                <Row label="Phone" value={submission.phone} />
                <Row label="Local authority" value={submission.la} />
                <Row label="Postcode" value={submission.postcode} />
                <Row label="Region" value={submission.region} />
              </Section>

              <Section title="About the learner">
                <Row label="Age band" value={labelAgeBand(submission.age_band)} />
                <Row label="Employment" value={labelEmployment(submission.employment_status)} />
                <Row label="Has Level 3 or higher" value={booleanLabel(submission.prior_level_3_or_higher)} />
                <Row label="What they're after" value={labelOutcomeInterest(submission.outcome_interest)} />
              </Section>

              <Section title="Course">
                <Row label="Course" value={labelCourse(submission.course_id)} />
                <Row label="Funding" value={labelFunding(submission.funding_category, submission.funding_route)} />
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
                  {submission.why_this_course || (
                    <span className="text-slate-400 italic">Nothing recorded.</span>
                  )}
                </p>
              </Section>
            </div>

            {fastrackDetail && (
              <FastrackSection detail={fastrackDetail} />
            )}
          </div>

          {/* RIGHT: notes log (sticky on lg+) */}
          <aside className="lg:col-span-1">
            <div className="bg-white border border-slate-200 rounded-xl p-5 lg:sticky lg:top-6 max-h-[calc(100vh-3rem)] flex flex-col">
              <div className="mb-3 shrink-0">
                <h2 className="text-sm font-semibold text-slate-900">Notes</h2>
                <p className="text-xs text-slate-500 mt-1">
                  Newest first. Visible to your team only.
                </p>
              </div>
              <NotesLog submissionId={submission.id} notes={notes} onAdd={addLeadNoteAction} />
            </div>
          </aside>
        </div>
      </div>
    </ProviderShell>
  );
}

function NavButton({
  href,
  label,
  direction,
}: {
  href: string | null;
  label: string;
  direction: "prev" | "next";
}) {
  const arrow = direction === "prev" ? "←" : "→";
  if (!href) {
    return (
      <span className="px-3 py-1.5 text-sm text-slate-300 cursor-not-allowed flex items-center gap-1">
        {direction === "prev" && arrow}
        {label}
        {direction === "next" && arrow}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="px-3 py-1.5 rounded-md text-sm text-slate-700 hover:bg-slate-100 hover:text-slate-900 cursor-pointer flex items-center gap-1 transition-colors"
    >
      {direction === "prev" && arrow}
      {label}
      {direction === "next" && arrow}
    </Link>
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
  if (canStart == null) {
    if (startTiming) return <Row label="Wants to start" value={labelStartTiming(startTiming)} />;
    if (startWhen) return <Row label="Wants to start" value={labelStartTiming(startWhen)} />;
    return <Row label="Can start on intake" value={null} />;
  }

  if (canStart === false) {
    return <Row label="Can start on intake" value="No" />;
  }

  const ids = (acceptableIntakeIds ?? []).filter((s) => s && s.length > 0);
  if (ids.length === 0 && !preferredIntakeId) {
    return <Row label="Can start on intake" value="Yes" />;
  }

  if (ids.length <= 1) {
    const onlyId = preferredIntakeId ?? ids[0] ?? null;
    return (
      <Row
        label="Can start on intake"
        value={onlyId ? `Yes — ${formatIntakeId(onlyId)}` : "Yes"}
      />
    );
  }

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

function FastrackSection({ detail }: { detail: FastrackDetailRow }) {
  const submitted = new Date(detail.submitted_at).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div className="bg-violet-50 border border-violet-200 rounded-xl p-5">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-violet-900">Fastrack submission</h2>
          <p className="text-xs text-violet-700 mt-0.5">
            Submitted {submitted}
          </p>
        </div>
      </div>

      {detail.l3_mismatch_flag && (
        <div className="mb-3 bg-rose-100 border border-rose-300 rounded-md p-3 text-sm text-rose-900">
          <strong>L3 mismatch flagged.</strong> The learner's reconfirmed Level 3 status doesn't
          match what we routed on. Confirm with them before enrolling — this routes via the
          waitlist if not resolved.
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        <FastrackRow label="Cohort confirmed" value={detail.cohort_confirmed} />
        <FastrackRow
          label="L3 reconfirmed"
          value={detail.l3_reconfirmed}
          tone={detail.l3_mismatch_flag ? "warn" : "default"}
        />
        <FastrackRow label="Docs ready" value={detail.docs_ready} />
        <FastrackRow label="Transport help requested" value={detail.transport_help_requested} />
        <FastrackRow label="Terms accepted" value={detail.terms_accepted} />
        <FastrackRow label="Opted in to marketing" value={detail.marketing_opt_in} />
      </div>

      {detail.voice_of_learner_intro && detail.voice_of_learner_intro.trim().length > 0 && (
        <div className="mt-4 pt-4 border-t border-violet-200">
          <p className="text-xs font-semibold uppercase tracking-wide text-violet-700 mb-1">
            Their intro
          </p>
          <blockquote className="text-sm text-violet-900 italic whitespace-pre-wrap break-words">
            &ldquo;{detail.voice_of_learner_intro}&rdquo;
          </blockquote>
        </div>
      )}
    </div>
  );
}

function FastrackRow({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: boolean;
  tone?: "default" | "warn";
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-violet-700">{label}</span>
      <span
        className={`text-sm font-medium ${
          tone === "warn" && !value
            ? "text-rose-700"
            : value
              ? "text-emerald-700"
              : "text-slate-500"
        }`}
      >
        {value ? "Yes" : "No"}
      </span>
    </div>
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
