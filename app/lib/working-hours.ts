// Working-hours arithmetic for provider SLA timers. "Working" = Mon-Fri
// treated as 24h/day; Sat + Sun count as zero. The provider portal SLAs
// say "1 working day to first contact" (weekends excluded) — a lead
// landing Friday 4pm BST shouldn't be flagged overdue Saturday 4pm.
//
// `.getDay()` reads local time on whatever runtime evaluates it
// (UTC on server, user-local on client). For pilot-scale UK providers
// this is within acceptable tolerance; precise BST handling can come
// later if a weekend-edge bug surfaces.

const HOUR_MS = 60 * 60 * 1000;

// Working ms elapsed between two timestamps. Iterates in 1-hour chunks
// (cheap for any reasonable window — even a 30-day lookback is 720
// iterations) so the day-of-week check applies per-hour, handling
// mid-day weekend crossings correctly.
export function workingMsBetween(start: Date, end: Date): number {
  if (end.getTime() <= start.getTime()) return 0;
  let working = 0;
  let cursor = start.getTime();
  const endMs = end.getTime();
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + HOUR_MS, endMs);
    const day = new Date(cursor).getDay();
    if (day !== 0 && day !== 6) {
      working += chunkEnd - cursor;
    }
    cursor = chunkEnd;
  }
  return working;
}

// True when more than `workingHours` of Mon-Fri elapsed time has passed
// since `iso`. Returns false on null input so callers can pass an
// optional "oldest open since" timestamp without an extra null guard.
export function isOverdueWorkingHours(iso: string | null, workingHours: number): boolean {
  if (!iso) return false;
  const start = new Date(iso);
  const now = new Date();
  return workingMsBetween(start, now) > workingHours * HOUR_MS;
}
