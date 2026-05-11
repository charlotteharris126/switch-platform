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
    case "attempt_1_no_answer":
    case "attempt_2_no_answer":
    case "attempt_3_no_answer":
      return "Calling";
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
//   - The label is "Calling". The DB has three attempt_*_no_answer states
//     and the sheet collapses them all to "Calling" — going back the other
//     way is ambiguous. Reconcile skips these; let sheet-edit-mirror's
//     Channel A handle attempt-count progression on real edit events.
//   - The label is unrecognised. Conservative: skip rather than guess.
//
// Case-insensitive, whitespace-trimmed. "Open" returns "open" so the
// caller can choose to no-op when sheet and DB both say open.
export function sheetLabelToStatus(label: string | null | undefined): string | null {
  if (label == null) return null;
  const norm = String(label).trim().toLowerCase();
  if (norm === "") return null;
  switch (norm) {
    case "open": return "open";
    case "calling": return null; // ambiguous, skip
    case "meeting booked": return "enrolment_meeting_booked";
    case "enrolled": return "enrolled";
    case "presumed enrolled": return "presumed_enrolled";
    case "lost": return "lost";
    case "cannot reach": return "cannot_reach";
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
