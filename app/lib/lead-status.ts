// Lead-outcome state machine, shared between Server Action validation
// (app/provider/leads/[id]/actions.ts) and client UI gating
// (app/provider/leads/[id]/outcome-buttons.tsx).
//
// Rule of thumb the owner asked for: once you've moved past a contact
// attempt, you can't roll back to an earlier one. Forward progression only
// for attempt counters. Terminal states (lost) don't unwind from the
// portal; admin can reset if needed.
//
// presumed_enrolled is a system-driven status (auto-flip cron) and is
// intentionally not a manual outcome.

export type LeadStatus =
  | "open"
  | "attempt_1_no_answer"
  | "attempt_2_no_answer"
  | "attempt_3_no_answer"
  | "enrolment_meeting_booked"
  | "enrolled"
  | "lost"
  | "cannot_reach"
  | "presumed_enrolled";

export const ALL_STATUSES: ReadonlyArray<LeadStatus> = [
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
};

const ALLOWED: Record<LeadStatus, ReadonlyArray<LeadStatus>> = {
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
  lost: [],
  cannot_reach: ["enrolment_meeting_booked", "enrolled", "lost"],
  presumed_enrolled: [],
};

export function allowedNextStatuses(current: LeadStatus): ReadonlyArray<LeadStatus> {
  return ALLOWED[current] ?? [];
}

export function isAllowedTransition(from: LeadStatus, to: LeadStatus): boolean {
  if (from === to) return true;
  return ALLOWED[from]?.includes(to) ?? false;
}

// When the next status is `lost`, the only valid lost_reason from `enrolled`
// is withdrew_after_enrolment. From any other state, all lost reasons are valid.
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

export function lostReasonsFor(from: LeadStatus): ReadonlyArray<LostReason> {
  if (from === "enrolled") return ["withdrew_after_enrolment"];
  return VALID_LOST_REASONS.filter((r) => r !== "withdrew_after_enrolment");
}

export function isLeadStatus(v: string): v is LeadStatus {
  return (ALL_STATUSES as ReadonlyArray<string>).includes(v);
}

export function isLostReason(v: string): v is LostReason {
  return (VALID_LOST_REASONS as ReadonlyArray<string>).includes(v);
}
