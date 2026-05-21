// Shared DB-state → provider-sheet-label transformers. Single source of
// truth for the two directions a sheet write touches: the status label
// (the sheet's dropdown values) and the lost_reason human text (the
// sheet's Lost Reason column).
//
// Used by `republish-provider-sheet` (forward writes DB → sheet) and
// `sheet-drift-reconcile-daily` (compares sheet against DB by projecting
// DB through these same functions, then string-comparing). Keeping the
// projection in one place is what makes drift detection trustworthy:
// the cron and the recovery tool agree on what "the sheet should say"
// for any given DB row.
//
// fastrack-receive has its own specialised lost_reason humaniser that
// handles the two fastrack-specific reasons with custom long-form text;
// it deliberately doesn't share this generic transformer.

export function statusToSheetLabel(status: string): string {
  switch (status) {
    case "open":
      return "Open";
    // Learner
    case "attempt_1_no_answer":
      return "Attempt 1 - no answer";
    case "attempt_2_no_answer":
      return "Attempt 2 - no answer";
    case "attempt_3_no_answer":
      return "Attempt 3 - no answer";
    case "enrolment_meeting_booked":
      return "Meeting booked";
    case "enrolled":
      return "Enrolled";
    case "presumed_enrolled":
      return "Presumed enrolled";
    case "lost":
      return "Lost";
    case "cannot_reach":
      return "Cannot reach";
    // Employer (Switchable for Business v1)
    case "engaged":
      return "Engaged";
    case "in_progress":
      return "In progress";
    case "signed":
      return "Signed";
    case "not_signed":
      return "Not signed";
    case "presumed_employer_signed":
      return "Presumed signed";
    default:
      return status;
  }
}

export function lostReasonHumanText(reason: string | null): string {
  if (!reason) return "";
  return reason
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Inverse of statusToSheetLabel — maps a sheet's status cell back to the
// canonical DB enum value. Used by the sheet → DB reconcile flow.
//
// Returns null when:
//   - The sheet cell is empty/null (treat as no-signal; the provider hasn't
//     touched it yet). Reconcile should leave DB alone.
//   - The label is unrecognised. Conservative: skip rather than guess.
//
// Case-insensitive, whitespace-trimmed. "Open" returns "open" so the
// caller can choose to no-op when sheet and DB both say open.
//
// Legacy "Calling" still maps to null (skip) for safety: any sheet cell
// that wasn't republished after the 2026-05-21 split keeps its old
// ambiguous behaviour rather than guessing an attempt count.
export function sheetLabelToStatus(label: string | null | undefined): string | null {
  if (label == null) return null;
  const norm = String(label).trim().toLowerCase();
  if (norm === "") return null;
  switch (norm) {
    // Learner
    case "open": return "open";
    case "attempt 1 - no answer":
    case "attempt_1_no_answer": return "attempt_1_no_answer";
    case "attempt 2 - no answer":
    case "attempt_2_no_answer": return "attempt_2_no_answer";
    case "attempt 3 - no answer":
    case "attempt_3_no_answer": return "attempt_3_no_answer";
    case "calling": return null; // legacy, pre-2026-05-21 split; ambiguous, skip
    case "meeting booked": return "enrolment_meeting_booked";
    case "enrolled": return "enrolled";
    case "presumed enrolled": return "presumed_enrolled";
    case "lost": return "lost";
    case "cannot reach": return "cannot_reach";
    // Employer (Switchable for Business v1)
    case "engaged": return "engaged";
    case "in progress": return "in_progress";
    case "signed": return "signed";
    case "not signed": return "not_signed";
    case "presumed signed": return "presumed_employer_signed";
    default: return null;
  }
}

// Inverse of lostReasonHumanText — maps a sheet's Lost Reason cell back to
// the canonical DB enum value. The forward humaniser snake-cases-to-spaces
// + title-cases, so the inverse is just a normalise + lookup table.
//
// Returns null when:
//   - cell is empty / null (no signal)
//   - text doesn't match a known reason (conservative: skip rather than guess)
//
// Case-insensitive, whitespace-trimmed. Known reasons mirror the LostReason
// enum in app/lib/lead-status.ts.
export function sheetLabelToLostReason(label: string | null | undefined): string | null {
  if (label == null) return null;
  const norm = String(label).trim().toLowerCase();
  if (norm === "") return null;
  switch (norm) {
    case "not interested": return "not_interested";
    case "wrong course": return "wrong_course";
    case "funding issue": return "funding_issue";
    case "cancelled": return "cancelled";
    case "withdrew after enrolment": return "withdrew_after_enrolment";
    case "l3 mismatch self reported": return "l3_mismatch_self_reported";
    case "cohort decline": return "cohort_decline";
    case "other": return "other";
    default: return null;
  }
}
