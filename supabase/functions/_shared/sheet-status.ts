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
