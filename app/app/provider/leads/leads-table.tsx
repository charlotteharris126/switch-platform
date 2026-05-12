"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { DurationTimer } from "../duration-timer";
import { STATUS_LABEL, type LeadStatus, type LostReason, VALID_LOST_REASONS } from "@/lib/lead-status";
import { labelCourse, labelFunding } from "@/lib/lead-values";

const STATUS_TONE: Record<LeadStatus, string> = {
  open: "bg-slate-100 text-slate-700 border-slate-200",
  attempt_1_no_answer: "bg-amber-50 text-amber-700 border-amber-200",
  attempt_2_no_answer: "bg-amber-100 text-amber-800 border-amber-300",
  attempt_3_no_answer: "bg-orange-100 text-orange-800 border-orange-300",
  enrolment_meeting_booked: "bg-blue-50 text-blue-700 border-blue-200",
  enrolled: "bg-emerald-50 text-emerald-700 border-emerald-200",
  presumed_enrolled: "bg-emerald-50 text-emerald-700 border-emerald-200",
  lost: "bg-rose-50 text-rose-700 border-rose-200",
  cannot_reach: "bg-rose-50 text-rose-700 border-rose-200",
  // Employer-lead palette — mirrors learner tones for sibling concepts:
  // engaged ≈ meeting_booked (blue), in_progress ≈ attempt (amber),
  // signed ≈ enrolled (emerald), not_signed ≈ lost (rose),
  // presumed_employer_signed ≈ presumed_enrolled (emerald).
  engaged: "bg-blue-50 text-blue-700 border-blue-200",
  in_progress: "bg-amber-50 text-amber-700 border-amber-200",
  signed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  not_signed: "bg-rose-50 text-rose-700 border-rose-200",
  presumed_employer_signed: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

export interface LeadRow {
  id: number;
  name: string;
  email: string | null;
  course_id: string | null;
  funding_category: string | null;
  routed_at: string | null;
  status: LeadStatus;
  status_updated_at: string | null;
  has_fastrack: boolean;
  callback_pending: boolean;
  // Lead-type discriminator. 'learner' (default) or 'employer_apprenticeship'.
  // When 'employer_apprenticeship', the table replaces the Course column
  // with Company, hides the cohort filter, and uses employer-shape status
  // pills via the unified STATUS_TONE map.
  lead_type: "learner" | "employer_apprenticeship";
  // Intake fields populated by lead payload v1.2. Used for the cohort
  // filter dropdown. Null for single-cohort / rolling-intake leads AND
  // for employer leads (which have no intake concept).
  preferred_intake_id: string | null;
  acceptable_intake_ids: string[] | null;
  // Employer-only display fields. Populated when lead_type ===
  // 'employer_apprenticeship', NULL on learner rows.
  company_name: string | null;
  role_title: string | null;
  sector: string | null;
}

export type Filter =
  | "all"
  | "action"
  | "callback"
  | "fastrack"
  | "open"
  | "calling"
  | "meeting"
  | "enrolled"
  | "cold"
  // Subset of "action": only attempts that have gone stale (status hasn't
  // moved in 36h+). Linked from the home page "call attempts need
  // retrying" card so the count + the click destination match exactly.
  | "stale_attempts"
  // Employer-shape filters. Used when isEmployerView (provider's leads
  // are all employer_apprenticeship). Each maps to a single status; the
  // 'near_60_day' filter is a derived subset (engaged | in_progress with
  // status_updated_at > 50 days ago).
  | "engaged"
  | "in_progress"
  | "signed"
  | "not_signed"
  | "near_60_day";

// "Action needed" is rendered separately above as its own prominent pill
// (rose when items waiting, emerald when zero). The standard filter row
// below covers everything else, branched by lead-type.
const LEARNER_FILTER_DEFS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "callback", label: "Needs callback" },
  { value: "fastrack", label: "Fastrack" },
  { value: "open", label: "Open" },
  { value: "calling", label: "Calling" },
  { value: "meeting", label: "Meeting booked" },
  { value: "enrolled", label: "Enrolled" },
  { value: "cold", label: "Cold" },
];
const EMPLOYER_FILTER_DEFS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "engaged", label: "Engaged" },
  { value: "in_progress", label: "In progress" },
  { value: "signed", label: "Signed" },
  { value: "not_signed", label: "Not signed" },
  { value: "near_60_day", label: "60-day clock" },
];

// Overdue thresholds. Mirror the home page so the badge logic is
// consistent across surfaces.
const OVERDUE_OPEN_MS = 24 * 60 * 60 * 1000; // 24h
const OVERDUE_36H_MS = 36 * 60 * 60 * 1000; // callback / attempt stale

// "Action needed" = anything where the next move is on the provider:
//   - callback flag pending
//   - status=open (no contact attempt yet, fastrack-or-not)
//   - status=attempt_X with status_updated_at >36h ago (stale follow-up)
// A fastrack flag alone doesn't gate action: once the provider has moved
// the status off open, they've actioned the fastrack signal. If the new
// status goes stale, it returns to actions via the stale-attempt timer.
// Fastrack stays visible as a row badge + own filter pill regardless.
const STALE_ATTEMPT_MS = OVERDUE_36H_MS;
function isActionRow(r: LeadRow): boolean {
  if (r.callback_pending) return true;
  if (r.status === "open") return true;
  if (isStaleAttempt(r)) return true;
  return false;
}

function isStaleAttempt(r: LeadRow): boolean {
  if (
    r.status !== "attempt_1_no_answer"
    && r.status !== "attempt_2_no_answer"
    && r.status !== "attempt_3_no_answer"
  ) {
    return false;
  }
  if (!r.status_updated_at) return false;
  return Date.now() - new Date(r.status_updated_at).getTime() > STALE_ATTEMPT_MS;
}

// Per-row overdue: any of (a) open + routed >24h ago, (b) callback flag
// pending + status hasn't moved in 36h, (c) attempt status stale (already
// >36h). Surfaces a red badge on the row plus a red dot on the lead name.
function isOverdueRow(r: LeadRow): boolean {
  if (r.status === "open" && r.routed_at) {
    if (Date.now() - new Date(r.routed_at).getTime() > OVERDUE_OPEN_MS) return true;
  }
  if (r.callback_pending && r.status_updated_at) {
    if (Date.now() - new Date(r.status_updated_at).getTime() > OVERDUE_36H_MS) return true;
  }
  if (isStaleAttempt(r)) return true;
  return false;
}

const CALLING = new Set<LeadStatus>([
  "attempt_1_no_answer",
  "attempt_2_no_answer",
  "attempt_3_no_answer",
]);
const ENROLLED = new Set<LeadStatus>(["enrolled", "presumed_enrolled"]);
const COLD = new Set<LeadStatus>(["lost", "cannot_reach"]);
// Statuses that mean a fastrack is no longer the next action. Excludes
// cannot_reach so a learner who comes back can still be picked up.
const FASTRACK_SETTLED = new Set<LeadStatus>(["lost", "enrolled", "presumed_enrolled"]);

type BulkResult = { ok: boolean; applied: number; skipped: number; error?: string };

interface Props {
  rows: LeadRow[];
  initialFilter?: Filter;
  // Optional. When omitted the bulk-mark UI (select column + BulkBar) is
  // hidden — used by the admin preview at /admin/preview/[provider_id]/leads
  // where writes need to stay disabled.
  onBulkMark?: (args: {
    submissionIds: number[];
    status: "attempt_advance" | "enrolment_meeting_booked" | "cannot_reach" | "lost";
    lostReason?: string | null;
  }) => Promise<BulkResult>;
  // Where lead-name links route to. Defaults to /provider/leads/. The admin
  // preview overrides this to /admin/leads/ so a click drops the admin into
  // their own lead detail page (which renders more than the provider one).
  linkPrefix?: string;
  // Canonical open intake IDs for the provider's courses, sourced from
  // crm.course_intakes (status='open'). Unioned with intake IDs derived
  // from the visible rows so the cohort filter always reflects the full
  // set of currently-open dates — even if no routed lead has populated
  // intake fields yet.
  seededCohortIds?: string[];
}

const LOST_REASON_LABEL: Record<LostReason, string> = {
  not_interested: "Not interested",
  wrong_course: "Wrong course",
  funding_issue: "Funding issue",
  cancelled: "Cancelled",
  withdrew_after_enrolment: "Withdrew after enrolment",
  l3_mismatch_self_reported: "L3 mismatch (self-reported)",
  cohort_decline: "Couldn't make the cohort dates",
  other: "Other",
};

// Lost reasons valid for bulk lost (from any non-enrolled state).
const BULK_LOST_REASONS = VALID_LOST_REASONS.filter((r) => r !== "withdrew_after_enrolment");

export function LeadsTable({
  rows,
  initialFilter = "all",
  onBulkMark,
  linkPrefix = "/provider/leads/",
  seededCohortIds = [],
}: Props) {
  // Lead-type detected from the loaded rows. In practice a provider's
  // leads are all one type (Riverside = employer, EMS/CD/WYK = learner)
  // so the first row is authoritative. If rows are empty, default to
  // learner shape (matches the historical default).
  const isEmployerView = rows.length > 0
    && rows.every((r) => r.lead_type === "employer_apprenticeship");
  // Bulk actions (BulkBar with "Tried no answer / Meeting booked / Cannot
  // reach / Lost") are learner-only. Employer flow is per-lead via
  // EmployerOutcomeButtons on the detail page. Disable the select column
  // + BulkBar entirely for employer view even when the caller passed
  // onBulkMark, so admin preview also respects this.
  const allowBulk = onBulkMark !== undefined && !isEmployerView;
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [query, setQuery] = useState("");
  const [courseFilter, setCourseFilter] = useState<string>("all");
  const [cohortFilter, setCohortFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkPending, startBulkTransition] = useTransition();
  const [showLostPicker, setShowLostPicker] = useState(false);
  const [lostReason, setLostReason] = useState<LostReason>(BULK_LOST_REASONS[0] ?? "other");
  const [bulkResult, setBulkResult] = useState<
    | { kind: "ok"; applied: number; skipped: number }
    | { kind: "error"; message: string }
    | null
  >(null);

  // Distinct courses present on this provider's loaded rows. Drives the
  // course filter dropdown. Sorted alphabetically for predictable order.
  const courseOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.course_id) set.add(r.course_id);
    }
    return [...set].sort();
  }, [rows]);

  // Distinct intake IDs across preferred + acceptable. IDs follow the
  // convention "<region>-<YYYY-MM-DD>" — parseIntakeDate pulls the date
  // for sort + label. Single-cohort / rolling-intake leads have null
  // intake fields and don't contribute to options (they pass any cohort
  // filter trivially when "all" is selected; on a specific cohort
  // they're excluded).
  const cohortOptions = useMemo(() => {
    const set = new Set<string>();
    // Union 1: intake IDs derived from visible rows.
    for (const r of rows) {
      if (r.preferred_intake_id) set.add(r.preferred_intake_id);
      if (Array.isArray(r.acceptable_intake_ids)) {
        for (const id of r.acceptable_intake_ids) set.add(id);
      }
    }
    // Union 2: canonical open intakes from crm.course_intakes (seeded by
    // the page). Surfaces dates the provider's courses currently have open
    // even when no routed lead has been submitted against that intake yet.
    for (const id of seededCohortIds) set.add(id);
    return [...set].sort((a, b) => {
      const aDate = parseIntakeDate(a) ?? "";
      const bDate = parseIntakeDate(b) ?? "";
      return aDate.localeCompare(bDate);
    });
  }, [rows, seededCohortIds]);

  const counts = useMemo(() => {
    let action = 0;
    let open = 0;
    let calling = 0;
    let meeting = 0;
    let enrolled = 0;
    let cold = 0;
    let callback = 0;
    let fastrack = 0;
    let stale_attempts = 0;
    let engaged = 0;
    let in_progress = 0;
    let signed = 0;
    let not_signed = 0;
    let near_60_day = 0;
    const FIFTY_DAYS_MS = 50 * 24 * 60 * 60 * 1000;
    for (const r of rows) {
      if (isActionRow(r)) action += 1;
      if (r.callback_pending) callback += 1;
      // Fastrack count excludes already-settled leads (lost, enrolled,
      // presumed_enrolled) — once a lead is closed out the fastrack is
      // no longer the next action. Matches the home-page badge logic.
      if (r.has_fastrack && !FASTRACK_SETTLED.has(r.status)) fastrack += 1;
      if (r.status === "open") open += 1;
      if (CALLING.has(r.status)) calling += 1;
      if (r.status === "enrolment_meeting_booked") meeting += 1;
      if (ENROLLED.has(r.status)) enrolled += 1;
      if (COLD.has(r.status)) cold += 1;
      if (isStaleAttempt(r)) stale_attempts += 1;
      // Employer counts
      if (r.status === "engaged") engaged += 1;
      if (r.status === "in_progress") in_progress += 1;
      if (r.status === "signed" || r.status === "presumed_employer_signed") signed += 1;
      if (r.status === "not_signed") not_signed += 1;
      if (
        (r.status === "engaged" || r.status === "in_progress")
        && r.status_updated_at
        && Date.now() - new Date(r.status_updated_at).getTime() > FIFTY_DAYS_MS
      ) {
        near_60_day += 1;
      }
    }
    return {
      all: rows.length,
      action, callback, fastrack, open, calling, meeting, enrolled, cold, stale_attempts,
      engaged, in_progress, signed, not_signed, near_60_day,
    };
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const subset = rows.filter((r) => {
      if (filter === "all") {
        // pass
      } else if (filter === "action") {
        if (!isActionRow(r)) return false;
      } else if (filter === "stale_attempts") {
        if (!isStaleAttempt(r)) return false;
      } else if (filter === "callback") {
        if (!r.callback_pending) return false;
      } else if (filter === "fastrack") {
        if (!r.has_fastrack || FASTRACK_SETTLED.has(r.status)) return false;
      } else if (filter === "open") {
        if (r.status !== "open") return false;
      } else if (filter === "calling") {
        if (!CALLING.has(r.status)) return false;
      } else if (filter === "meeting") {
        if (r.status !== "enrolment_meeting_booked") return false;
      } else if (filter === "enrolled") {
        if (!ENROLLED.has(r.status)) return false;
      } else if (filter === "cold") {
        if (!COLD.has(r.status)) return false;
      } else if (filter === "engaged") {
        if (r.status !== "engaged") return false;
      } else if (filter === "in_progress") {
        if (r.status !== "in_progress") return false;
      } else if (filter === "signed") {
        if (r.status !== "signed" && r.status !== "presumed_employer_signed") return false;
      } else if (filter === "not_signed") {
        if (r.status !== "not_signed") return false;
      } else if (filter === "near_60_day") {
        const fifty = 50 * 24 * 60 * 60 * 1000;
        const stale =
          (r.status === "engaged" || r.status === "in_progress")
          && r.status_updated_at
          && Date.now() - new Date(r.status_updated_at).getTime() > fifty;
        if (!stale) return false;
      }
      if (courseFilter !== "all" && r.course_id !== courseFilter) return false;
      if (cohortFilter !== "all") {
        const matchesPreferred = r.preferred_intake_id === cohortFilter;
        const matchesAcceptable = Array.isArray(r.acceptable_intake_ids)
          && r.acceptable_intake_ids.includes(cohortFilter);
        if (!matchesPreferred && !matchesAcceptable) return false;
      }
      if (q.length > 0) {
        // Search matches across: lead ID (numeric), name, email, course slug.
        // Stripping a leading '#' so "#371" works as well as "371".
        const qStripped = q.startsWith("#") ? q.slice(1) : q;
        const haystack =
          `${r.id} ${r.name} ${r.email ?? ""} ${r.course_id ?? ""}`.toLowerCase();
        if (!haystack.includes(qStripped)) return false;
      }
      return true;
    });
    // Pin order: overdue → fastrack (unsettled) → callback → routed_at desc.
    // Applied within every filter, not just "all" — keeps the same hierarchy
    // visible inside Open / Calling / etc. The server returns routed_at desc
    // already, so the final tier mostly reinforces that.
    return [...subset].sort((a, b) => {
      const aOver = isOverdueRow(a) ? 1 : 0;
      const bOver = isOverdueRow(b) ? 1 : 0;
      if (aOver !== bOver) return bOver - aOver;
      const aFast = (a.has_fastrack && !FASTRACK_SETTLED.has(a.status)) ? 1 : 0;
      const bFast = (b.has_fastrack && !FASTRACK_SETTLED.has(b.status)) ? 1 : 0;
      if (aFast !== bFast) return bFast - aFast;
      const aCb = a.callback_pending ? 1 : 0;
      const bCb = b.callback_pending ? 1 : 0;
      if (aCb !== bCb) return bCb - aCb;
      const aRouted = a.routed_at ? new Date(a.routed_at).getTime() : 0;
      const bRouted = b.routed_at ? new Date(b.routed_at).getTime() : 0;
      return bRouted - aRouted;
    });
  }, [rows, filter, query, courseFilter, cohortFilter]);

  return (
    <div>
      {/* Action-needed sits on its own row above the other filter pills
          so it's prominent — Charlotte's the-thing-you-should-do-now
          glance state. Hidden on employer view because the action
          definition (callback / open / stale-attempt) is learner-specific. */}
      {!isEmployerView && (
        <div className="mb-2">
          <FilterPill
            label="Action needed"
            count={counts.action}
            active={filter === "action"}
            onClick={() => setFilter(filter === "action" ? "all" : "action")}
            tone="rose"
          />
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex flex-wrap gap-1">
          {(isEmployerView ? EMPLOYER_FILTER_DEFS : LEARNER_FILTER_DEFS).map((f) => (
            <FilterPill
              key={f.value}
              label={f.label}
              count={(counts as Record<string, number>)[f.value] ?? 0}
              active={filter === f.value}
              onClick={() => setFilter(f.value)}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email, course, or #ID"
            className="border border-slate-300 rounded-md pl-3 pr-3 py-1.5 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>
      </div>

      {(courseOptions.length > 1 || cohortOptions.length > 0) && (
        <RefineFilters
          courseOptions={courseOptions}
          courseFilter={courseFilter}
          setCourseFilter={setCourseFilter}
          cohortOptions={cohortOptions}
          cohortFilter={cohortFilter}
          setCohortFilter={setCohortFilter}
        />
      )}

      {filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-500 text-sm bg-white border border-slate-200 rounded-xl">
          No leads match.
        </div>
      ) : (
        <>
          {allowBulk && selected.size > 0 && (
            <BulkBar
              selectedCount={selected.size}
              pending={bulkPending}
              showLostPicker={showLostPicker}
              lostReason={lostReason}
              onLostReasonChange={setLostReason}
              onCancel={() => {
                setSelected(new Set());
                setShowLostPicker(false);
                setBulkResult(null);
              }}
              onAdvanceAttempt={() => {
                setBulkResult(null);
                startBulkTransition(async () => {
                  const ids = [...selected];
                  const r = await onBulkMark!({ submissionIds: ids, status: "attempt_advance" });
                  if (r.ok) {
                    setBulkResult({ kind: "ok", applied: r.applied, skipped: r.skipped });
                    setSelected(new Set());
                  } else {
                    setBulkResult({ kind: "error", message: r.error ?? "Failed" });
                  }
                });
              }}
              onMarkMeeting={() => {
                setBulkResult(null);
                startBulkTransition(async () => {
                  const ids = [...selected];
                  const r = await onBulkMark!({ submissionIds: ids, status: "enrolment_meeting_booked" });
                  if (r.ok) {
                    setBulkResult({ kind: "ok", applied: r.applied, skipped: r.skipped });
                    setSelected(new Set());
                  } else {
                    setBulkResult({ kind: "error", message: r.error ?? "Failed" });
                  }
                });
              }}
              onCannotReach={() => {
                setBulkResult(null);
                startBulkTransition(async () => {
                  const ids = [...selected];
                  const r = await onBulkMark!({ submissionIds: ids, status: "cannot_reach" });
                  if (r.ok) {
                    setBulkResult({ kind: "ok", applied: r.applied, skipped: r.skipped });
                    setSelected(new Set());
                  } else {
                    setBulkResult({ kind: "error", message: r.error ?? "Failed" });
                  }
                });
              }}
              onLostClick={() => setShowLostPicker((v) => !v)}
              onLostConfirm={() => {
                setBulkResult(null);
                startBulkTransition(async () => {
                  const ids = [...selected];
                  const r = await onBulkMark!({
                    submissionIds: ids,
                    status: "lost",
                    lostReason,
                  });
                  if (r.ok) {
                    setBulkResult({ kind: "ok", applied: r.applied, skipped: r.skipped });
                    setSelected(new Set());
                    setShowLostPicker(false);
                  } else {
                    setBulkResult({ kind: "error", message: r.error ?? "Failed" });
                  }
                });
              }}
              onExportSelected={async () => {
                const { downloadCsv } = await import("./csv-export");
                downloadCsv(filtered.filter((r) => selected.has(r.id)));
              }}
              result={bulkResult}
            />
          )}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  {allowBulk && (
                    <th className="px-4 py-3 w-10">
                      <input
                        type="checkbox"
                        checked={
                          filtered.length > 0 && filtered.every((r) => selected.has(r.id))
                        }
                        ref={(el) => {
                          if (el) {
                            const some = filtered.some((r) => selected.has(r.id));
                            const all = filtered.every((r) => selected.has(r.id));
                            el.indeterminate = some && !all;
                          }
                        }}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) {
                            for (const r of filtered) next.add(r.id);
                          } else {
                            for (const r of filtered) next.delete(r.id);
                          }
                          setSelected(next);
                        }}
                        className="cursor-pointer"
                        aria-label="Select all visible leads"
                      />
                    </th>
                  )}
                  <th className="text-left px-4 py-3 font-semibold w-20">ID</th>
                  <th className="text-left px-4 py-3 font-semibold">Name</th>
                  <th className="text-left px-4 py-3 font-semibold">{isEmployerView ? "Company" : "Course"}</th>
                  <th className="text-left px-4 py-3 font-semibold">In your queue</th>
                  <th className="text-left px-4 py-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((r) => {
                  const overdue = isOverdueRow(r);
                  const isEmployer = r.lead_type === "employer_apprenticeship";
                  const courseOrCompanyLabel = isEmployer
                    ? (r.company_name ?? "-")
                    : (labelCourse(r.course_id) ?? r.course_id ?? "-");
                  const subLabel = isEmployer
                    ? (r.role_title ?? r.sector ?? null)
                    : labelFunding(r.funding_category, null);
                  return (
                  <tr
                    key={r.id}
                    className={`hover:bg-slate-50 transition-colors ${
                      selected.has(r.id)
                        ? "bg-slate-100"
                        : overdue
                          ? "bg-rose-50"
                          : r.callback_pending
                            ? "bg-rose-50/50"
                            : r.has_fastrack
                              ? "bg-violet-50/40"
                              : ""
                    }`}
                  >
                    {allowBulk && (
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(r.id);
                            else next.delete(r.id);
                            setSelected(next);
                          }}
                          className="cursor-pointer"
                          aria-label={`Select ${r.name}`}
                        />
                      </td>
                    )}
                    <td className="px-4 py-3 text-xs font-mono text-slate-500 tabular-nums">
                      #{r.id}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        {r.callback_pending && (
                          <span className="inline-block w-2 h-2 rounded-full bg-rose-500" aria-label="Callback requested" />
                        )}
                        <Link href={`${linkPrefix}${r.id}`} className="text-slate-900 font-medium hover:underline cursor-pointer">
                          {r.name}
                        </Link>
                        {overdue && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-rose-600 text-white">
                            Overdue
                          </span>
                        )}
                        {r.callback_pending && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-rose-100 text-rose-800 border border-rose-200">
                            Callback
                          </span>
                        )}
                        {r.has_fastrack && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-violet-100 text-violet-800 border border-violet-200">
                            Fastrack
                          </span>
                        )}
                      </div>
                      {r.email && <div className="text-xs text-slate-500">{r.email}</div>}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {courseOrCompanyLabel}
                      {subLabel && (
                        <div className="text-xs text-slate-500">{subLabel}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-700 tabular-nums">
                      <DurationTimer since={r.routed_at} />
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${STATUS_TONE[r.status] ?? "bg-slate-100 text-slate-700 border-slate-200"}`}>
                        {STATUS_LABEL[r.status] ?? r.status}
                      </span>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function BulkBar({
  selectedCount,
  pending,
  showLostPicker,
  lostReason,
  onLostReasonChange,
  onCancel,
  onAdvanceAttempt,
  onMarkMeeting,
  onCannotReach,
  onLostClick,
  onLostConfirm,
  onExportSelected,
  result,
}: {
  selectedCount: number;
  pending: boolean;
  showLostPicker: boolean;
  lostReason: LostReason;
  onLostReasonChange: (r: LostReason) => void;
  onCancel: () => void;
  onAdvanceAttempt: () => void;
  onMarkMeeting: () => void;
  onCannotReach: () => void;
  onLostClick: () => void;
  onLostConfirm: () => void;
  onExportSelected: () => void;
  result:
    | { kind: "ok"; applied: number; skipped: number }
    | { kind: "error"; message: string }
    | null;
}) {
  return (
    <div className="mb-3 bg-slate-900 text-white rounded-xl p-3 flex flex-wrap items-center gap-3">
      <span className="text-sm font-semibold tabular-nums">
        {selectedCount} selected
      </span>
      <div className="flex flex-wrap items-center gap-2 ml-auto">
        <button
          type="button"
          onClick={onAdvanceAttempt}
          disabled={pending}
          title="Tried each selected lead, no answer. Advances each by one attempt step (open→1, 1→2, 2→3). Leads past attempt_3 or already terminal are skipped."
          className="px-3 py-1.5 text-xs font-semibold bg-slate-100 text-slate-900 rounded-md hover:bg-white disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          {pending ? "Marking…" : "Tried, no answer"}
        </button>
        <button
          type="button"
          onClick={onMarkMeeting}
          disabled={pending}
          className="px-3 py-1.5 text-xs font-semibold bg-blue-400 text-blue-950 rounded-md hover:bg-blue-300 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          {pending ? "Marking…" : "Meeting booked"}
        </button>
        <button
          type="button"
          onClick={onCannotReach}
          disabled={pending}
          className="px-3 py-1.5 text-xs font-semibold bg-amber-500 text-amber-950 rounded-md hover:bg-amber-400 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          {pending ? "Marking…" : "Cannot reach"}
        </button>
        <button
          type="button"
          onClick={onLostClick}
          disabled={pending}
          className="px-3 py-1.5 text-xs font-semibold bg-rose-500 text-rose-950 rounded-md hover:bg-rose-400 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          Lost…
        </button>
        <button
          type="button"
          onClick={onExportSelected}
          disabled={pending}
          className="px-3 py-1.5 text-xs font-semibold bg-slate-700 text-white rounded-md hover:bg-slate-600 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          Export
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="px-3 py-1.5 text-xs text-slate-300 hover:text-white cursor-pointer disabled:cursor-not-allowed"
        >
          Cancel
        </button>
      </div>

      {showLostPicker && (
        <div className="basis-full bg-slate-800 rounded-md p-3 flex flex-wrap items-center gap-2">
          <label className="text-xs text-slate-300">Lost reason:</label>
          <select
            value={lostReason}
            onChange={(e) => onLostReasonChange(e.target.value as LostReason)}
            disabled={pending}
            className="border border-slate-600 bg-slate-900 text-white rounded-md px-2 py-1.5 text-xs cursor-pointer disabled:cursor-not-allowed"
          >
            {BULK_LOST_REASONS.map((r) => (
              <option key={r} value={r}>
                {LOST_REASON_LABEL[r]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onLostConfirm}
            disabled={pending}
            className="px-3 py-1.5 text-xs font-semibold bg-rose-500 text-rose-950 rounded-md hover:bg-rose-400 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            {pending ? "Marking…" : "Confirm Mark Lost"}
          </button>
        </div>
      )}

      {result?.kind === "ok" && (
        <div className="basis-full text-xs text-emerald-300">
          Marked {result.applied}.{" "}
          {result.skipped > 0 ? `${result.skipped} skipped (state machine wouldn't allow).` : ""}
        </div>
      )}
      {result?.kind === "error" && (
        <div className="basis-full text-xs text-rose-300">{result.message}</div>
      )}
    </div>
  );
}

// CSV export helpers live in ./csv-export.ts and are dynamically imported
// from the BulkBar's Export button so the helper code (~2KB) only ships to
// the client on the first click, not on every leads-list render.

// Pull the YYYY-MM-DD date out of an intake id of the form
// "<region>-<YYYY-MM-DD>". Returns null if the suffix isn't a date.
function parseIntakeDate(intakeId: string | null | undefined): string | null {
  if (!intakeId) return null;
  const m = intakeId.match(/(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : null;
}

// Short cohort label for the filter pill: "26 May" (year-omitted unless
// the cohort straddles years). Falls back to the raw id if the date
// can't be parsed.
function cohortDisplayName(intakeId: string): string {
  const date = parseIntakeDate(intakeId);
  if (!date) return intakeId;
  const d = new Date(date + "T00:00:00Z");
  const thisYear = new Date().getUTCFullYear();
  const opts: Intl.DateTimeFormatOptions = d.getUTCFullYear() === thisYear
    ? { day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" };
  return d.toLocaleDateString("en-GB", opts);
}

// Pretty course label from the canonical course_id slug.
// "counselling-skills-tees-valley" → "Counselling Skills"
// "smm-for-ecommerce-tees-valley" → "SMM for Ecommerce"
// The region/location suffix (tees-valley, lift-camden-etc) is dropped
// since cohort filter already conveys location. Known multi-word
// acronyms / lowercase fillers handled by the small-words guard.
function courseDisplayName(courseId: string | null | undefined): string {
  if (!courseId) return "—";
  // Strip known region suffixes. List grows as new regions ship.
  const REGION_SUFFIXES = [
    "-tees-valley",
    "-lift-camden",
    "-lift-hackney",
    "-lift-islington",
    "-lift-boroughs",
  ];
  let core = courseId;
  for (const suffix of REGION_SUFFIXES) {
    if (core.endsWith(suffix)) { core = core.slice(0, -suffix.length); break; }
  }
  const SMALL_WORDS = new Set(["for", "and", "of", "the", "in", "on", "to", "a"]);
  const ACRONYMS: Record<string, string> = { smm: "SMM", crm: "CRM", l3: "L3", l4: "L4" };
  return core
    .split("-")
    .map((word, i) => {
      if (ACRONYMS[word]) return ACRONYMS[word];
      if (i > 0 && SMALL_WORDS.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

// Secondary filters (course + cohort) shown in a collapsible "Refine" row.
// Default collapsed when there are >0 secondary filter dimensions, so the
// primary status row stays the focus. Active filters are visible at all
// times via the "1 course / 2 cohorts" summary so the provider always
// knows what's narrowing their view.
function RefineFilters({
  courseOptions,
  courseFilter,
  setCourseFilter,
  cohortOptions,
  cohortFilter,
  setCohortFilter,
}: {
  courseOptions: string[];
  courseFilter: string;
  setCourseFilter: (v: string) => void;
  cohortOptions: string[];
  cohortFilter: string;
  setCohortFilter: (v: string) => void;
}) {
  const hasCourses = courseOptions.length > 1;
  const hasCohorts = cohortOptions.length > 0;
  const anyActive = (courseFilter !== "all") || (cohortFilter !== "all");
  const [open, setOpen] = useState<boolean>(anyActive);

  const courseActiveLabel = courseFilter === "all"
    ? null
    : courseDisplayName(courseFilter);
  const cohortActiveLabel = cohortFilter === "all"
    ? null
    : cohortDisplayName(cohortFilter);

  function clearAll() {
    setCourseFilter("all");
    setCohortFilter("all");
  }

  return (
    <div className="mb-3 bg-slate-50 border border-slate-200 rounded-md px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs font-semibold text-slate-700 hover:text-slate-900 cursor-pointer flex items-center gap-1"
        >
          <span>{open ? "−" : "+"}</span>
          <span>Refine by course / cohort</span>
        </button>
        {courseActiveLabel && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-white border border-slate-300 rounded-full">
            <span className="text-slate-500">Course:</span>
            <span className="text-slate-900 font-medium">{courseActiveLabel}</span>
            <button
              type="button"
              onClick={() => setCourseFilter("all")}
              className="ml-0.5 text-slate-400 hover:text-slate-700 cursor-pointer"
              aria-label="Clear course filter"
            >
              ×
            </button>
          </span>
        )}
        {cohortActiveLabel && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-white border border-slate-300 rounded-full">
            <span className="text-slate-500">Cohort:</span>
            <span className="text-slate-900 font-medium">{cohortActiveLabel}</span>
            <button
              type="button"
              onClick={() => setCohortFilter("all")}
              className="ml-0.5 text-slate-400 hover:text-slate-700 cursor-pointer"
              aria-label="Clear cohort filter"
            >
              ×
            </button>
          </span>
        )}
        {anyActive && (
          <button
            type="button"
            onClick={clearAll}
            className="text-[11px] text-slate-500 hover:text-slate-900 underline-offset-2 hover:underline ml-auto cursor-pointer"
          >
            Clear refinements
          </button>
        )}
      </div>

      {open && (
        <div className="mt-3 space-y-2">
          {hasCourses && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[11px] uppercase tracking-wide font-semibold text-slate-500 mr-2 w-14">
                Course
              </span>
              <SecondaryPill
                label="All"
                active={courseFilter === "all"}
                onClick={() => setCourseFilter("all")}
              />
              {courseOptions.map((c) => (
                <SecondaryPill
                  key={c}
                  label={courseDisplayName(c)}
                  active={courseFilter === c}
                  onClick={() => setCourseFilter(c)}
                />
              ))}
            </div>
          )}
          {hasCohorts && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[11px] uppercase tracking-wide font-semibold text-slate-500 mr-2 w-14">
                Cohort
              </span>
              <SecondaryPill
                label="All"
                active={cohortFilter === "all"}
                onClick={() => setCohortFilter("all")}
              />
              {cohortOptions.map((c) => (
                <SecondaryPill
                  key={c}
                  label={cohortDisplayName(c)}
                  active={cohortFilter === c}
                  onClick={() => setCohortFilter(c)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SecondaryPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-0.5 rounded-full text-[11px] border transition-colors cursor-pointer ${
        active
          ? "bg-slate-900 text-white border-slate-900"
          : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"
      }`}
    >
      {label}
    </button>
  );
}

function FilterPill({
  label,
  count,
  active,
  onClick,
  tone,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  // Default tone uses slate (dark when active). `rose` is used by the
  // "Action needed" pill — red outline when inactive, red filled when
  // active — to match the existing visual language of the other pills
  // while staying clearly distinct as the attention-grabber.
  tone?: "slate" | "rose";
}) {
  const isRose = tone === "rose";
  const palette = active
    ? isRose
      ? "bg-rose-700 text-white border-rose-700"
      : "bg-slate-900 text-white border-slate-900"
    : isRose
      ? "bg-white text-rose-700 border-rose-300 hover:bg-rose-50 hover:border-rose-400"
      : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:border-slate-300";
  const countTone = active
    ? "text-white/70"
    : isRose
      ? "text-rose-400"
      : "text-slate-400";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors cursor-pointer ${palette}`}
    >
      {label}
      <span className={`ml-1.5 text-xs tabular-nums ${countTone}`}>
        {count}
      </span>
    </button>
  );
}
