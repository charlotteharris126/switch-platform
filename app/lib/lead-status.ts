// Lead-outcome state machine, shared between Server Action validation
// (app/provider/leads/[id]/actions.ts) and client UI gating
// (app/provider/leads/[id]/outcome-buttons.tsx).
//
// Two lead types share this module:
//   - learner (B2C): funded / self-funded / loan-funded course enquiries.
//     Status set models call-attempt funnel through to enrolled.
//   - employer_apprenticeship (B2B): Switchable for Business v1 employer
//     leads routed to apprenticeship providers (Riverside in v1). Status
//     set models meeting-driven sales: engaged → in_progress → signed,
//     with a 60-day Presumed Employer Signed auto-flip mirroring the
//     14-day learner Presumed Enrolment auto-flip.
//
// Rule of thumb the owner asked for: once you've moved past a contact
// attempt, you can't roll back to an earlier one. Forward progression only
// for attempt counters. Terminal states (lost / not_signed) are recoverable
// from the portal; the cron-driven Presumed states are not (admin only).

export type LeadType = "learner" | "employer_apprenticeship";

// Universal "no action taken yet" state. Both lead types start here when
// routed; first provider action moves them into type-specific tracks.
type SharedStatus = "open";

export type LearnerStatus =
  | SharedStatus
  | "attempt_1_no_answer"
  | "attempt_2_no_answer"
  | "attempt_3_no_answer"
  | "enrolment_meeting_booked"
  | "enrolled"
  | "lost"
  | "cannot_reach"
  | "presumed_enrolled";

export type EmployerStatus =
  | SharedStatus
  | "engaged"
  | "in_progress"
  | "signed"
  | "not_signed"
  | "presumed_employer_signed";

export type LeadStatus = LearnerStatus | EmployerStatus;

export const ALL_LEARNER_STATUSES: ReadonlyArray<LearnerStatus> = [
  "open",
  "attempt_1_no_answer",
  "attempt_2_no_answer",
  "attempt_3_no_answer",
  "enrolment_meeting_booked",
  "enrolled",
  "lost",
  "cannot_reach",
  "presumed_enrolled",
];

export const ALL_EMPLOYER_STATUSES: ReadonlyArray<EmployerStatus> = [
  "open",
  "engaged",
  "in_progress",
  "signed",
  "not_signed",
  "presumed_employer_signed",
];

export const ALL_STATUSES: ReadonlyArray<LeadStatus> = [
  ...ALL_LEARNER_STATUSES,
  // Skip 'open' on the employer pass — already in the learner list.
  ...ALL_EMPLOYER_STATUSES.filter((s) => s !== "open"),
];

// Labels are lead-type-aware because "Enrolled" makes no sense for
// employers and "Signed" makes no sense for learners. STATUS_LABEL is a
// single combined map keyed by every possible LeadStatus so existing
// callers (which index by raw LeadStatus without knowing lead_type)
// continue to typecheck. New code branching on lead_type should call
// statusLabel(leadType, status) explicitly — same string for shared
// statuses, lead-type-specific string otherwise.
export const STATUS_LABEL: Record<LeadStatus, string> = {
  open: "Open",
  attempt_1_no_answer: "1st no answer",
  attempt_2_no_answer: "2nd no answer",
  attempt_3_no_answer: "3rd no answer",
  enrolment_meeting_booked: "Meeting booked",
  enrolled: "Enrolled",
  presumed_enrolled: "Presumed enrolled",
  lost: "Lost",
  cannot_reach: "Cannot reach",
  engaged: "Engaged",
  in_progress: "In progress",
  signed: "Signed",
  not_signed: "Not signed",
  presumed_employer_signed: "Presumed signed",
};

export function statusLabel(leadType: LeadType, status: LeadStatus): string {
  // Same combined map; the function exists for call-site clarity and to
  // give us a single hook if employer/learner labels for a shared status
  // ever need to diverge (they don't today — both call "open" → "Open").
  return STATUS_LABEL[status] ?? String(status);
}

const ALLOWED_LEARNER: Record<LearnerStatus, ReadonlyArray<LearnerStatus>> = {
  open: [
    "attempt_1_no_answer",
    "enrolment_meeting_booked",
    "enrolled",
    "lost",
    "cannot_reach",
  ],
  attempt_1_no_answer: [
    "attempt_2_no_answer",
    "enrolment_meeting_booked",
    "enrolled",
    "lost",
    "cannot_reach",
  ],
  attempt_2_no_answer: [
    "attempt_3_no_answer",
    "enrolment_meeting_booked",
    "enrolled",
    "lost",
    "cannot_reach",
  ],
  attempt_3_no_answer: [
    "enrolment_meeting_booked",
    "enrolled",
    "lost",
    "cannot_reach",
  ],
  enrolment_meeting_booked: ["enrolled", "lost", "cannot_reach"],
  enrolled: ["lost"],
  // lost is recoverable. Providers can correct a mis-click (wrong button)
  // or move a lead back into the cycle if the learner re-engages and
  // verifies things. Anything except 'open' (system default) and a no-op
  // back to 'lost' is allowed.
  lost: [
    "attempt_1_no_answer",
    "attempt_2_no_answer",
    "attempt_3_no_answer",
    "enrolment_meeting_booked",
    "enrolled",
    "cannot_reach",
  ],
  cannot_reach: ["enrolment_meeting_booked", "enrolled", "lost"],
  presumed_enrolled: [],
};

// Employer transitions. The B2B sales funnel is shorter and meeting-driven:
//   open → engaged (first contact made)
//   engaged → in_progress (deal moving, multiple touches)
//   in_progress → signed (contract executed) | not_signed (declined / dropped)
//   not_signed is recoverable (mirrors learner 'lost' semantics).
//   presumed_employer_signed is terminal (cron-driven 60-day auto-flip).
const ALLOWED_EMPLOYER: Record<EmployerStatus, ReadonlyArray<EmployerStatus>> = {
  open: ["engaged", "in_progress", "signed", "not_signed"],
  engaged: ["in_progress", "signed", "not_signed"],
  in_progress: ["signed", "not_signed"],
  signed: ["not_signed"],
  not_signed: ["engaged", "in_progress", "signed"],
  presumed_employer_signed: [],
};

export function allowedNextStatuses(
  current: LeadStatus,
  leadType: LeadType = "learner",
): ReadonlyArray<LeadStatus> {
  if (leadType === "employer_apprenticeship") {
    return ALLOWED_EMPLOYER[current as EmployerStatus] ?? [];
  }
  return ALLOWED_LEARNER[current as LearnerStatus] ?? [];
}

export function isAllowedTransition(
  from: LeadStatus,
  to: LeadStatus,
  leadType: LeadType = "learner",
): boolean {
  if (from === to) return true;
  return allowedNextStatuses(from, leadType).includes(to);
}

// When the next status is `lost` (learner) or `not_signed` (employer), a
// reason is captured for the audit trail. Reasons diverge by lead type.
export const VALID_LOST_REASONS = [
  "not_interested",
  "wrong_course",
  "funding_issue",
  "cancelled",
  "withdrew_after_enrolment",
  "l3_mismatch_self_reported",
  "cohort_decline",
  "other",
] as const;

export type LostReason = (typeof VALID_LOST_REASONS)[number];

export const VALID_NOT_SIGNED_REASONS = [
  "budget",
  "wrong_levy_fit",
  "timing",
  "competitor",
  "decided_not_to_proceed",
  "no_response",
  "other",
] as const;

export type NotSignedReason = (typeof VALID_NOT_SIGNED_REASONS)[number];

export const NOT_SIGNED_REASON_LABEL: Record<NotSignedReason, string> = {
  budget: "Budget",
  wrong_levy_fit: "Wrong levy fit",
  timing: "Timing",
  competitor: "Went with competitor",
  decided_not_to_proceed: "Decided not to proceed",
  no_response: "No response",
  other: "Other",
};

export function lostReasonsFor(from: LeadStatus): ReadonlyArray<LostReason> {
  if (from === "enrolled") return ["withdrew_after_enrolment"];
  return VALID_LOST_REASONS.filter((r) => r !== "withdrew_after_enrolment");
}

export function isLeadStatus(v: string): v is LeadStatus {
  return (ALL_STATUSES as ReadonlyArray<string>).includes(v);
}

export function isLearnerStatus(v: string): v is LearnerStatus {
  return (ALL_LEARNER_STATUSES as ReadonlyArray<string>).includes(v);
}

export function isEmployerStatus(v: string): v is EmployerStatus {
  return (ALL_EMPLOYER_STATUSES as ReadonlyArray<string>).includes(v);
}

export function isLostReason(v: string): v is LostReason {
  return (VALID_LOST_REASONS as ReadonlyArray<string>).includes(v);
}

export function isNotSignedReason(v: string): v is NotSignedReason {
  return (VALID_NOT_SIGNED_REASONS as ReadonlyArray<string>).includes(v);
}
