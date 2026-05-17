import { isOverdueWorkingHours } from "./working-hours";
import type { LeadStatus } from "./lead-status";

export interface OverdueRow {
  status: LeadStatus;
  status_updated_at: string | null;
  routed_at: string | null;
  callback_pending: boolean;
}

export function isStaleAttempt(r: OverdueRow, staleAttemptMs: number): boolean {
  if (
    r.status !== "attempt_1_no_answer" &&
    r.status !== "attempt_2_no_answer" &&
    r.status !== "attempt_3_no_answer"
  ) {
    return false;
  }
  if (!r.status_updated_at) return false;
  return Date.now() - new Date(r.status_updated_at).getTime() > staleAttemptMs;
}

// A row is overdue if any of:
//   (a) status='open' and routed_at older than the first-attempt SLA in
//       working hours (Mon-Fri only, weekends excluded by SLA agreement).
//   (b) callback flag pending and status_updated_at older than the
//       stale-attempt SLA (clock hours, weekends count).
//   (c) attempt status with status_updated_at older than the stale-attempt
//       SLA (clock hours).
export function isOverdueRow(
  r: OverdueRow,
  openWorkingHours: number,
  staleAttemptMs: number,
): boolean {
  if (r.status === "open" && r.routed_at) {
    if (isOverdueWorkingHours(r.routed_at, openWorkingHours)) return true;
  }
  if (r.callback_pending && r.status_updated_at) {
    if (Date.now() - new Date(r.status_updated_at).getTime() > staleAttemptMs) return true;
  }
  if (isStaleAttempt(r, staleAttemptMs)) return true;
  return false;
}
