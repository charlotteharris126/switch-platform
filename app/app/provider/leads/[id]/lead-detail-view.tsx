// Presentational view for a single lead. Pure render — accepts pre-fetched
// data + link prefixes + optional action callbacks.
//
// Two callers:
//   1. /provider/leads/[id]/page.tsx — real provider session, action
//      callbacks wired, link prefixes pointing at /provider.
//   2. /admin/preview/[provider_id]/leads/[lead_id]/page.tsx — admin
//      impersonation, action callbacks OMITTED so every interactive
//      surface (outcome buttons, notes compose, auto-mark-read) renders
//      hidden or read-only. Link prefixes point at /preview/<id>.
//
// Mirrors the ProviderHomeView pattern: data + link prefixes + optional
// action props. When an action prop is omitted, the corresponding UI is
// hidden so preview mode can never fire a write.

import Link from "next/link";
import { DurationTimer } from "../../duration-timer";
import { OutcomeButtons } from "./outcome-buttons";
import { EmployerOutcomeButtons } from "./employer-outcome-buttons";
import { NotesLog, type NoteRow } from "./notes-log";
import { MarkAdminNotesRead } from "./mark-admin-notes-read";
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

export interface LeadDetailSubmission {
  id: number;
  routed_at: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  // Lead-type discriminator. 'learner' (default) or 'employer_apprenticeship'.
  // Branches the "About" + "Course" sections of the detail view to render
  // employer fields when employer.
  lead_type: "learner" | "employer_apprenticeship";
  // Learner-shape fields. Populated for lead_type='learner'.
  age_band: string | null;
  employment_status: string | null;
  earnings_band: string | null;
  course_id: string | null;
  funding_category: string | null;
  funding_route: string | null;
  pay_route: string | null;
  prior_level_3_or_higher: boolean | null;
  can_start_on_intake_date: boolean | null;
  preferred_intake_id: string | null;
  acceptable_intake_ids: string[] | null;
  start_when: string | null;
  start_timing: string | null;
  outcome_interest: string | null;
  la: string | null;
  postcode: string | null;
  region: string | null;
  // Employer-shape fields. Populated for lead_type='employer_apprenticeship'.
  company_name: string | null;
  role_title: string | null;
  company_size_band: string | null;
  sector: string | null;
  levy_status: string | null;
  urgency: string | null;
  interest: string | null;
  candidate_in_mind: string | null;
  existing_apprentices: string | null;
  headcount_estimate: string | null;
  standards_interested: string | null;
  additional_notes: string | null;
}

export interface LeadDetailEnrolment {
  status: string;
  outcome_note: string | null;
  status_updated_at: string;
  callback_requested_at: string | null;
}

export interface FastrackDetail {
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

export interface LeadDetailViewProps {
  submission: LeadDetailSubmission;
  enrol: LeadDetailEnrolment | null;
  notes: NoteRow[];
  fastrackDetail: FastrackDetail | null;
  hasFastrack: boolean;
  hasUnreadAdminNote: boolean;
  status: LeadStatus;
  // ISO timestamp of the most recent chaser email sent to this learner.
  // Pulled from crm.email_log (same record the admin /admin/leads
  // "Last chaser" column reads). NULL when no chaser has ever been sent.
  // Surfaces in the "At current status" tile so providers can see at a
  // glance whether the learner has had a Switchable nudge recently.
  lastChaserAt: string | null;
  // Re-application history: ISO timestamps of later submissions from the same
  // learner (children of this lead), oldest first. Empty/undefined when none.
  // Surfaces the eagerness signal on the detail view, matching the list badge.
  reapplications?: string[];
  // Sibling navigation. Caller pre-computes prev/next ids per its ordering.
  prevId: number | null;
  nextId: number | null;
  positionLabel: string | null;
  // Where "All leads" + prev/next links target. Real provider passes
  // "/provider/leads", admin preview passes "/preview/<id>/leads".
  leadsListHref: string;
  // Prefix for prev/next individual lead hrefs. Real provider passes
  // "/provider/leads/", admin preview passes "/preview/<id>/leads/".
  leadDetailPrefix: string;
  // Action callbacks. Omit to render the surface read-only.
  onMarkOutcome?: (args: {
    submissionId: number;
    status: string;
    lostReason?: string | null;
    outcomeNote?: string | null;
  }) => Promise<{ ok: boolean; error?: string }>;
  onAddNote?: (args: { submissionId: number; body: string }) => Promise<{ ok: boolean; error?: string }>;
  onMarkAdminNotesRead?: (args: { submissionId: number }) => Promise<{ ok: boolean; error?: string }>;
}

export function LeadDetailView({
  submission,
  enrol,
  notes,
  fastrackDetail,
  hasFastrack,
  hasUnreadAdminNote,
  status,
  lastChaserAt,
  reapplications = [],
  prevId,
  nextId,
  positionLabel,
  leadsListHref,
  leadDetailPrefix,
  onMarkOutcome,
  onAddNote,
  onMarkAdminNotesRead,
}: LeadDetailViewProps) {
  const callbackPending = enrol?.callback_requested_at != null;
  // Private-pay learner: came through a funded page but did not qualify for
  // funding and chose to pay. The provider bills them the course fee directly.
  const isPrivatePay = submission.pay_route === "private";

  return (
    <div className="max-w-7xl mx-auto p-6">
      {/* Header row: back link + prev/next */}
      <div className="flex items-center justify-between gap-3">
        <Link
          href={leadsListHref}
          className="text-sm text-slate-600 hover:text-slate-900 cursor-pointer"
        >
          &larr; All leads
        </Link>
        <div className="flex items-center gap-1 text-sm">
          <span className="text-xs text-slate-500 mr-2">{positionLabel ?? ""}</span>
          <NavButton
            href={prevId ? `${leadDetailPrefix}${prevId}` : null}
            label="Previous"
            direction="prev"
          />
          <NavButton
            href={nextId ? `${leadDetailPrefix}${nextId}` : null}
            label="Next"
            direction="next"
          />
        </div>
      </div>

      {/* Title */}
      <div className="mt-4 flex items-baseline gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold text-slate-900">
          {[submission.first_name, submission.last_name].filter(Boolean).join(" ") ||
            submission.email ||
            `Lead ${submission.id}`}
        </h1>
        <span className="text-sm font-mono text-slate-500 tabular-nums">
          #{submission.id}
        </span>
        {callbackPending && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold bg-rose-100 text-rose-800 border border-rose-200">
            Callback requested
          </span>
        )}
        {hasFastrack && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold bg-violet-100 text-violet-800 border border-violet-200">
            Fastrack submitted
          </span>
        )}
        {reapplications.length > 0 && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold bg-amber-100 text-amber-800 border border-amber-300">
            Re-applied{reapplications.length > 1 ? ` ×${reapplications.length}` : ""}
          </span>
        )}
        {isPrivatePay && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold bg-amber-100 text-amber-800 border border-amber-300">
            Private pay
          </span>
        )}
      </div>
      <p className="text-sm text-slate-500 mt-1">
        Current status: <strong className="text-slate-900">{STATUS_LABEL[status] ?? status}</strong>
      </p>

      {isPrivatePay && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">Self-funding learner — bill them directly</p>
          <p className="mt-1 text-sm text-amber-900">
            This learner did not qualify for funding and chose to pay for the course. Enrol them as a paying student and bill them the course fee directly. This is not a funded place.
          </p>
        </div>
      )}

      {reapplications.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">This learner has enquired more than once</p>
          <ul className="mt-2 space-y-1 text-sm text-amber-900">
            {[
              ...(submission.routed_at ? [{ at: submission.routed_at, label: "First enquiry" }] : []),
              ...reapplications.map((at) => ({ at, label: "Re-applied" })),
            ].map((e, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="font-medium w-24 shrink-0">{e.label}</span>
                <span>{new Date(e.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Auto-mark unread admin notes as read on view. Only when caller
          provided the callback — in preview, viewing must never write. */}
      {hasUnreadAdminNote && onMarkAdminNotesRead && (
        <MarkAdminNotesRead submissionId={submission.id} onMark={onMarkAdminNotesRead} />
      )}

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
                Routed {submission.routed_at ? new Date(submission.routed_at).toLocaleDateString("en-GB") : "-"}
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
                    : "-"}
              </p>
              {enrol?.outcome_note && (status === "lost" || status === "cannot_reach") && (
                <p className="text-xs text-slate-700 mt-2 italic border-l-2 border-slate-300 pl-2">
                  &quot;{enrol.outcome_note}&quot;
                </p>
              )}
              {lastChaserAt && (
                <p className="text-xs text-slate-500 mt-2">
                  {submission.lead_type === "employer_apprenticeship"
                    ? "Last chaser sent to employer: "
                    : "Last chaser sent to learner: "}
                  <span className="text-slate-700 font-medium">
                    {new Date(lastChaserAt).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}
                  </span>
                </p>
              )}
            </div>
          </div>

          {/* Outcome marking. Hidden entirely in read-only preview.
              Employer leads render a different stepper (Engaged → In
              progress → Signed, plus a Not signed closeout) — see
              EmployerOutcomeButtons. */}
          {onMarkOutcome ? (
            <div className="bg-white border border-slate-200 rounded-xl p-6">
              <h2 className="text-sm font-semibold text-slate-900">Mark outcome</h2>
              <p className="text-xs text-slate-500 mt-1">
                Click whichever applies. Forward only: once you&apos;ve moved past a step you can&apos;t go back.
                Every change is logged.
              </p>
              {submission.lead_type === "employer_apprenticeship" ? (
                <EmployerOutcomeButtons
                  submissionId={submission.id}
                  currentStatus={status}
                  onMark={onMarkOutcome}
                />
              ) : (
                <OutcomeButtons
                  submissionId={submission.id}
                  currentStatus={status}
                  onMark={onMarkOutcome}
                />
              )}
            </div>
          ) : (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-slate-500">
              Outcome controls hidden in read-only preview.
              {submission.lead_type === "employer_apprenticeship"
                ? " The provider sees a stepper here: Open → Engaged → In progress → Signed, plus a Not signed closeout."
                : " The provider sees a stepper here: Open → Calls → Meeting booked → Enrolled, plus Lost and Cannot reach."}
            </div>
          )}

          {/* Lead detail cards — branched by lead_type. Employer leads
              render company / role / sector / levy fields instead of the
              learner-shape About + Course sections. */}
          {submission.lead_type === "employer_apprenticeship" ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Section title="Contact">
                <Row label="Email" value={submission.email} />
                <Row label="Phone" value={submission.phone} />
                <Row label="Role" value={submission.role_title} />
              </Section>

              <Section title="Company">
                <Row label="Company name" value={submission.company_name} />
                <Row label="Sector" value={submission.sector} />
                <Row label="Size band" value={submission.company_size_band} />
                <Row label="Levy status" value={submission.levy_status} />
              </Section>

              <Section title="Apprenticeship interest">
                <Row label="Interest" value={submission.interest} />
                <Row label="Urgency" value={submission.urgency} />
                <Row label="Standard" value={submission.standards_interested} />
                <Row label="Candidate in mind" value={submission.candidate_in_mind} />
              </Section>

              <Section title="Context">
                <Row label="Existing apprentices" value={submission.existing_apprentices} />
                <Row label="Headcount estimate" value={submission.headcount_estimate} />
                {submission.additional_notes && (
                  <div className="mt-2">
                    <p className="text-xs uppercase tracking-wide font-semibold text-slate-500">Their notes</p>
                    <p className="text-sm text-slate-800 mt-1 italic border-l-2 border-slate-300 pl-3">
                      &quot;{submission.additional_notes}&quot;
                    </p>
                  </div>
                )}
              </Section>
            </div>
          ) : (
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
                <Row label="Earnings band" value={submission.earnings_band === "under_30k" ? "Under £30,000" : submission.earnings_band === "over_30k" ? "Over £30,000" : submission.earnings_band} />
                <Row label="Has Level 3 or higher" value={booleanLabel(submission.prior_level_3_or_higher)} />
                <Row label="What they're after" value={labelOutcomeInterest(submission.outcome_interest)} />
              </Section>

              <Section title="Course">
                <Row label="Course" value={labelCourse(submission.course_id)} />
                <Row label="Funding" value={isPrivatePay ? "Self-funding (learner pays the course fee)" : labelFunding(submission.funding_category, submission.funding_route)} />
                <IntakeRow
                  canStart={submission.can_start_on_intake_date}
                  preferredIntakeId={submission.preferred_intake_id}
                  acceptableIntakeIds={submission.acceptable_intake_ids}
                  startWhen={submission.start_when}
                  startTiming={submission.start_timing}
                />
              </Section>
            </div>
          )}

          {fastrackDetail && <FastrackSection detail={fastrackDetail} />}
        </div>

        {/* RIGHT: notes log (sticky on lg+) */}
        <aside className="lg:col-span-1">
          <div className="bg-white border border-slate-200 rounded-xl p-5 lg:sticky lg:top-6 max-h-[calc(100vh-3rem)] flex flex-col">
            <div className="mb-3 shrink-0">
              <h2 className="text-sm font-semibold text-slate-900">Notes</h2>
              <p className="text-xs text-slate-500 mt-1">
                {onAddNote
                  ? "Newest first. Visible to your team only."
                  : "Newest first. Read-only in preview."}
              </p>
            </div>
            <NotesLog submissionId={submission.id} notes={notes} onAdd={onAddNote} />
          </div>
        </aside>
      </div>
    </div>
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
      <Row label="Can start on intake" value={onlyId ? `Yes, ${formatIntakeId(onlyId)}` : "Yes"} />
    );
  }

  const sorted = [...ids].sort();
  return (
    <div className="text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-slate-500">Can start on intake</span>
        <span className="text-slate-900 font-medium">Yes, {sorted.length} dates</span>
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

function FastrackSection({ detail }: { detail: FastrackDetail }) {
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
          <p className="text-xs text-violet-700 mt-0.5">Submitted {submitted}</p>
        </div>
      </div>

      {detail.l3_mismatch_flag && (
        <div className="mb-3 bg-rose-100 border border-rose-300 rounded-md p-3 text-sm text-rose-900">
          <strong>L3 mismatch flagged.</strong> The learner&apos;s reconfirmed Level 3 status doesn&apos;t
          match what we routed on. Confirm with them before enrolling, or it routes via the
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
      <span className="text-slate-900 text-right">{value || <span className="text-slate-400">-</span>}</span>
    </div>
  );
}

function booleanLabel(v: boolean | null): string | null {
  if (v === true) return "Yes";
  if (v === false) return "No";
  return null;
}
