"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { markEnrolmentOutcome, type EnrolmentStatus, type LostReason } from "./actions";

interface Props {
  submissionId: number;
  currentStatus: string | null;
  currentNotes: string | null;
  currentLostReason: string | null;
  currentDisputedAt: string | null;
  currentDisputedReason: string | null;
  isRouted: boolean;
  // Determines which status + reason set the form shows. Defaults to
  // learner. Employer leads (lead_type='employer_apprenticeship') get
  // the B2B status set (engaged / in_progress / signed / not_signed +
  // presumed_employer_signed) and the employer not_signed reasons.
  leadType?: "learner" | "employer_apprenticeship";
}

const LEARNER_STATUSES: Array<{ value: EnrolmentStatus; label: string; description: string }> = [
  { value: "open",              label: "Open",              description: "No outcome yet. Provider hasn't confirmed contact." },
  { value: "enrolled",          label: "Enrolled",          description: "Learner started the course. Counts toward billing." },
  { value: "presumed_enrolled", label: "Presumed enrolled", description: "Provider hasn't confirmed after 14 days. Auto-set by cron normally." },
  { value: "cannot_reach",      label: "Cannot reach",      description: "Provider tried to contact but no response after multiple attempts." },
  { value: "lost",              label: "Lost",              description: "Provider made contact but learner won't enrol. Pick a reason." },
];

const EMPLOYER_STATUSES: Array<{ value: EnrolmentStatus; label: string; description: string }> = [
  { value: "open",                       label: "Open",              description: "No outcome yet. Provider has 1 wd to first attempt." },
  { value: "attempt_1_no_answer",        label: "1st no answer",     description: "First call, no answer." },
  { value: "attempt_2_no_answer",        label: "2nd no answer",     description: "Second call, no answer." },
  { value: "attempt_3_no_answer",        label: "3rd no answer",     description: "Third call, no answer." },
  { value: "cannot_reach",               label: "Cannot reach",      description: "3 attempts over a fortnight, no response. Closure." },
  { value: "engaged",                    label: "Engaged",           description: "Got through. First conversation done." },
  { value: "in_progress",                label: "In progress",       description: "Deal moving — multiple touches, proposal stage." },
  { value: "signed",                     label: "Signed",            description: "Employer signed the apprenticeship agreement. Counts toward billing." },
  { value: "presumed_employer_signed",   label: "Presumed signed",   description: "Provider hasn't confirmed after 60 days. Auto-set by cron normally." },
  { value: "not_signed",                 label: "Not signed",        description: "Engaged but won't proceed. Pick a reason." },
];

const LEARNER_LOST_REASONS: Array<{ value: LostReason; label: string }> = [
  { value: "not_interested",            label: "Not interested" },
  { value: "wrong_course",              label: "Wrong course" },
  { value: "funding_issue",             label: "Funding issue" },
  { value: "cancelled",                 label: "Cancelled (pre-start)" },
  { value: "withdrew_after_enrolment",  label: "Withdrew (post-enrolment)" },
  { value: "l3_mismatch_self_reported", label: "L3 mismatch (self-reported)" },
  { value: "cohort_decline",            label: "Couldn't make the cohort dates" },
  { value: "other",                     label: "Other" },
];

const EMPLOYER_NOT_SIGNED_REASONS: Array<{ value: LostReason; label: string }> = [
  { value: "budget",                  label: "Budget" },
  { value: "wrong_levy_fit",          label: "Wrong levy fit" },
  { value: "timing",                  label: "Timing" },
  { value: "competitor",              label: "Went with competitor" },
  { value: "decided_not_to_proceed",  label: "Decided not to proceed" },
  { value: "no_response",             label: "No response" },
  { value: "other",                   label: "Other" },
];

export function EnrolmentOutcomeForm({
  submissionId,
  currentStatus,
  currentNotes,
  currentLostReason,
  currentDisputedAt,
  currentDisputedReason,
  isRouted,
  leadType = "learner",
}: Props) {
  const isEmployer = leadType === "employer_apprenticeship";
  const STATUSES = isEmployer ? EMPLOYER_STATUSES : LEARNER_STATUSES;
  const LOST_REASONS = isEmployer ? EMPLOYER_NOT_SIGNED_REASONS : LEARNER_LOST_REASONS;
  const closureStatus: EnrolmentStatus = isEmployer ? "not_signed" : "lost";
  const presumedStatus: EnrolmentStatus = isEmployer ? "presumed_employer_signed" : "presumed_enrolled";
  const [pending, startTransition] = useTransition();
  const [displayStatus, setDisplayStatus] = useState<string | null>(currentStatus);
  const [selectedStatus, setSelectedStatus] = useState<EnrolmentStatus | null>(
    isStatus(currentStatus) ? currentStatus : null,
  );
  const [selectedReason, setSelectedReason] = useState<LostReason | null>(
    isLostReason(currentLostReason) ? currentLostReason : null,
  );
  const [notes, setNotes] = useState(currentNotes ?? "");
  const [disputed, setDisputed] = useState(Boolean(currentDisputedAt));
  const [disputedReason, setDisputedReason] = useState(currentDisputedReason ?? "");

  if (!isRouted) {
    return (
      <div className="bg-white border border-[#dad4cb] rounded-xl p-4 shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
        <h3 className="text-sm font-extrabold text-[#11242e] mb-1">Enrolment outcome</h3>
        <p className="text-xs text-[#5a6a72]">Lead must be routed to a provider before an outcome can be recorded.</p>
      </div>
    );
  }

  const showLostReason = selectedStatus === closureStatus;
  const showDisputeBlock = selectedStatus === presumedStatus;
  const closureReasonHeading = isEmployer ? "Why didn't they sign?" : "Why was it lost?";

  function handleSubmit() {
    if (!selectedStatus) {
      toast.warning("Pick a status before saving.");
      return;
    }
    if (selectedStatus === closureStatus && !selectedReason) {
      toast.warning(`Pick a reason for ${isEmployer ? "Not signed" : "Lost"} before saving.`);
      return;
    }
    if (disputed && (!disputedReason || disputedReason.trim().length === 0)) {
      toast.warning("Add a dispute reason before saving.");
      return;
    }

    const previousDisplay = displayStatus;
    setDisplayStatus(selectedStatus);

    startTransition(async () => {
      const result = await markEnrolmentOutcome({
        submissionId,
        status:         selectedStatus,
        notes:          notes.trim() || null,
        lostReason:     selectedStatus === closureStatus ? selectedReason : null,
        disputed:       selectedStatus === presumedStatus ? disputed : false,
        disputedReason: selectedStatus === presumedStatus && disputed ? disputedReason.trim() || null : null,
      });
      if (result.ok) {
        toast.success("Outcome saved", {
          description: `Marked as ${selectedStatus.replace(/_/g, " ")}.`,
        });
      } else {
        setDisplayStatus(previousDisplay);
        toast.error("Save failed", { description: result.error ?? "Unknown error." });
      }
    });
  }

  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-4 shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
      <h3 className="text-sm font-extrabold text-[#11242e] mb-1">Enrolment outcome</h3>
      {displayStatus && (
        <p className="text-[11px] text-[#5a6a72] mb-3">
          Currently: <span className="font-bold uppercase tracking-wide text-[#143643]">{displayStatus.replace(/_/g, " ")}</span>
          {currentDisputedAt && (
            <> · <span className="font-bold uppercase tracking-wide text-[#cd8b76]">disputed</span></>
          )}
        </p>
      )}

      {/* Status buttons */}
      <div className="flex flex-wrap gap-2 mb-3">
        {STATUSES.map((s) => {
          const selected = selectedStatus === s.value;
          return (
            <button
              key={s.value}
              type="button"
              onClick={() => setSelectedStatus(s.value)}
              disabled={pending}
              title={s.description}
              className={
                "px-4 h-9 text-xs font-bold uppercase tracking-[0.08em] rounded-full border transition-all duration-150 active:scale-[0.97] " +
                (selected
                  ? "bg-[#cd8b76] text-white border-[#cd8b76] shadow-[0_2px_6px_rgba(205,139,118,0.35)]"
                  : "bg-white text-[#143643] border-[#dad4cb] hover:border-[#cd8b76]/60 hover:bg-[#fbf9f5] hover:-translate-y-px")
              }
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {/* Conditional: closure reason radio appears when status=Lost (learner)
          or Not signed (employer). */}
      {showLostReason && (
        <div className="mb-3 pl-3 border-l-2 border-[#cd8b76]">
          <p className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72] mb-2">{closureReasonHeading}</p>
          <div className="flex flex-wrap gap-2">
            {LOST_REASONS.map((r) => {
              const selected = selectedReason === r.value;
              return (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => setSelectedReason(r.value)}
                  disabled={pending}
                  className={
                    "px-3 h-8 text-[11px] font-bold uppercase tracking-[0.06em] rounded-full border transition-all duration-150 active:scale-[0.97] " +
                    (selected
                      ? "bg-[#143643] text-white border-[#143643]"
                      : "bg-white text-[#143643] border-[#dad4cb] hover:border-[#143643]/60")
                  }
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Conditional: dispute flag appears when status=Presumed enrolled */}
      {showDisputeBlock && (
        <div className="mb-3 pl-3 border-l-2 border-[#143643]">
          <label className="flex items-center gap-2 mb-2">
            <input
              type="checkbox"
              checked={disputed}
              onChange={(e) => setDisputed(e.target.checked)}
              disabled={pending}
              className="h-4 w-4 accent-[#cd8b76]"
            />
            <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#11242e]">Provider disputes this</span>
          </label>
          {disputed && (
            <textarea
              value={disputedReason}
              onChange={(e) => setDisputedReason(e.target.value)}
              placeholder="What is the provider's reason for the dispute?"
              rows={2}
              disabled={pending}
              className="w-full text-xs border border-[#dad4cb] rounded-lg bg-white px-3 py-2 text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76] resize-y"
            />
          )}
        </div>
      )}

      {/* Legacy notes editor removed — admin notes now live in the dedicated
          AdminNotesPanel below, mirrored to the provider portal with author
          + timestamp + audit. Existing crm.enrolments.notes value is
          preserved on submit (the `notes` state is initialised from
          currentNotes and re-sent unchanged), so historical text isn't
          nulled. Column drop will follow in a later migration. */}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={pending || !selectedStatus}
          className="h-9 px-5 text-[11px] font-bold uppercase tracking-[0.08em] rounded-full bg-[#143643] text-white hover:bg-[#11242e] active:scale-[0.97] transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[#143643] shadow-[0_2px_6px_rgba(17,36,46,0.15)]"
        >
          {pending ? "Saving..." : "Save outcome"}
        </button>
      </div>
    </div>
  );
}

function isStatus(value: string | null): value is EnrolmentStatus {
  if (!value) return false;
  return [
    // Learner
    "open", "attempt_1_no_answer", "attempt_2_no_answer", "attempt_3_no_answer",
    "enrolment_meeting_booked", "enrolled", "presumed_enrolled",
    "cannot_reach", "lost",
    // Employer
    "engaged", "in_progress", "signed", "not_signed", "presumed_employer_signed",
  ].includes(value);
}

function isLostReason(value: string | null): value is LostReason {
  if (!value) return false;
  return [
    // Learner
    "not_interested", "wrong_course", "funding_issue", "cancelled",
    "withdrew_after_enrolment", "l3_mismatch_self_reported", "cohort_decline",
    // Employer
    "budget", "wrong_levy_fit", "timing", "competitor",
    "decided_not_to_proceed", "no_response",
    // Shared
    "other",
  ].includes(value);
}
