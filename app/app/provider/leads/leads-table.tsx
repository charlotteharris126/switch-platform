"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { DurationTimer } from "../duration-timer";
import { STATUS_LABEL, type LeadStatus, type LostReason, VALID_LOST_REASONS } from "@/lib/lead-status";

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
  | "cold";

// "Action needed" is rendered separately above as its own prominent pill
// (rose when items waiting, emerald when zero). The standard filter row
// below covers everything else.
const FILTER_DEFS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "callback", label: "Needs callback" },
  { value: "fastrack", label: "Fastrack" },
  { value: "open", label: "Open" },
  { value: "calling", label: "Calling" },
  { value: "meeting", label: "Meeting booked" },
  { value: "enrolled", label: "Enrolled" },
  { value: "cold", label: "Cold" },
];

// "Action needed" = anything where the next move is on the provider:
//   - callback flag pending
//   - fastrack ready (lead has fastrack submission, not yet settled)
//   - status=open (no contact attempt yet)
//   - status=attempt_X with status_updated_at >48h ago (stale follow-up)
const STALE_ATTEMPT_MS = 48 * 60 * 60 * 1000;
function isActionRow(r: LeadRow): boolean {
  if (r.callback_pending) return true;
  if (r.has_fastrack && r.status !== "lost" && r.status !== "presumed_enrolled") return true;
  if (r.status === "open") return true;
  if (
    (r.status === "attempt_1_no_answer" ||
      r.status === "attempt_2_no_answer" ||
      r.status === "attempt_3_no_answer") &&
    r.status_updated_at &&
    Date.now() - new Date(r.status_updated_at).getTime() > STALE_ATTEMPT_MS
  ) {
    return true;
  }
  return false;
}

const CALLING = new Set<LeadStatus>([
  "attempt_1_no_answer",
  "attempt_2_no_answer",
  "attempt_3_no_answer",
]);
const ENROLLED = new Set<LeadStatus>(["enrolled", "presumed_enrolled"]);
const COLD = new Set<LeadStatus>(["lost", "cannot_reach"]);

type BulkResult = { ok: boolean; applied: number; skipped: number; error?: string };

interface Props {
  rows: LeadRow[];
  initialFilter?: Filter;
  onBulkMark: (args: {
    submissionIds: number[];
    status: "cannot_reach" | "lost";
    lostReason?: string | null;
  }) => Promise<BulkResult>;
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

export function LeadsTable({ rows, initialFilter = "all", onBulkMark }: Props) {
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkPending, startBulkTransition] = useTransition();
  const [showLostPicker, setShowLostPicker] = useState(false);
  const [lostReason, setLostReason] = useState<LostReason>(BULK_LOST_REASONS[0] ?? "other");
  const [bulkResult, setBulkResult] = useState<
    | { kind: "ok"; applied: number; skipped: number }
    | { kind: "error"; message: string }
    | null
  >(null);

  const counts = useMemo(() => {
    let action = 0;
    let open = 0;
    let calling = 0;
    let meeting = 0;
    let enrolled = 0;
    let cold = 0;
    let callback = 0;
    let fastrack = 0;
    for (const r of rows) {
      if (isActionRow(r)) action += 1;
      if (r.callback_pending) callback += 1;
      if (r.has_fastrack) fastrack += 1;
      if (r.status === "open") open += 1;
      if (CALLING.has(r.status)) calling += 1;
      if (r.status === "enrolment_meeting_booked") meeting += 1;
      if (ENROLLED.has(r.status)) enrolled += 1;
      if (COLD.has(r.status)) cold += 1;
    }
    return { all: rows.length, action, callback, fastrack, open, calling, meeting, enrolled, cold };
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const subset = rows.filter((r) => {
      if (filter === "all") {
        // pass
      } else if (filter === "action") {
        if (!isActionRow(r)) return false;
      } else if (filter === "callback") {
        if (!r.callback_pending) return false;
      } else if (filter === "fastrack") {
        if (!r.has_fastrack) return false;
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
      }
      if (q.length > 0) {
        const haystack = `${r.name} ${r.email ?? ""} ${r.course_id ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    // Pin order: callback flag → fastrack → server's routed_at desc.
    return [...subset].sort((a, b) => {
      const aCb = a.callback_pending ? 1 : 0;
      const bCb = b.callback_pending ? 1 : 0;
      if (aCb !== bCb) return bCb - aCb;
      const aFast = a.has_fastrack ? 1 : 0;
      const bFast = b.has_fastrack ? 1 : 0;
      if (aFast !== bFast) return bFast - aFast;
      return 0;
    });
  }, [rows, filter, query]);

  return (
    <div>
      {/* Action-needed pill — elevated above the standard filter row.
          Dark red when there's anything waiting, emerald when all clear.
          Compact pill (not full-width) with a clear active vs inactive
          distinction (ring + darker fill when selected as the filter). */}
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setFilter(filter === "action" ? "all" : "action")}
          aria-pressed={filter === "action"}
          className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border transition-colors cursor-pointer text-sm font-semibold ${
            counts.action > 0
              ? filter === "action"
                ? "bg-rose-900 border-rose-900 text-white ring-2 ring-rose-300 ring-offset-2"
                : "bg-rose-700 border-rose-700 hover:bg-rose-800 hover:border-rose-800 text-white"
              : filter === "action"
                ? "bg-emerald-800 border-emerald-800 text-white ring-2 ring-emerald-300 ring-offset-2"
                : "bg-emerald-50 border-emerald-200 hover:bg-emerald-100 hover:border-emerald-300 text-emerald-800"
          }`}
        >
          <span>Action needed</span>
          <span className="tabular-nums leading-none">
            {counts.action > 0 ? counts.action : "✓"}
          </span>
        </button>
        {filter === "action" && (
          <span className="text-xs text-slate-500">
            Filtered. Click again or pick another filter to clear.
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex flex-wrap gap-1">
          {FILTER_DEFS.map((f) => (
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
            placeholder="Search name or course"
            className="border border-slate-300 rounded-md pl-3 pr-3 py-1.5 text-sm w-56 focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
          <button
            type="button"
            onClick={() => downloadCsv(filtered)}
            disabled={filtered.length === 0}
            title={
              filter === "all" && query.length === 0
                ? "Download all leads as CSV"
                : "Download the current filtered view as CSV"
            }
            className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 hover:border-slate-400 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            Export CSV
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-500 text-sm bg-white border border-slate-200 rounded-xl">
          No leads match.
        </div>
      ) : (
        <>
          {selected.size > 0 && (
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
              onCannotReach={() => {
                setBulkResult(null);
                startBulkTransition(async () => {
                  const ids = [...selected];
                  const r = await onBulkMark({ submissionIds: ids, status: "cannot_reach" });
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
                  const r = await onBulkMark({
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
              onExportSelected={() =>
                downloadCsv(filtered.filter((r) => selected.has(r.id)))
              }
              result={bulkResult}
            />
          )}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
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
                  <th className="text-left px-4 py-3 font-semibold">Name</th>
                  <th className="text-left px-4 py-3 font-semibold">Course</th>
                  <th className="text-left px-4 py-3 font-semibold">In your queue</th>
                  <th className="text-left px-4 py-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((r) => (
                  <tr
                    key={r.id}
                    className={`hover:bg-slate-50 transition-colors ${
                      selected.has(r.id)
                        ? "bg-slate-100"
                        : r.callback_pending
                          ? "bg-rose-50/50"
                          : r.has_fastrack
                            ? "bg-violet-50/40"
                            : ""
                    }`}
                  >
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
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        {r.callback_pending && (
                          <span className="inline-block w-2 h-2 rounded-full bg-rose-500" aria-label="Callback requested" />
                        )}
                        <Link href={`/provider/leads/${r.id}`} className="text-slate-900 font-medium hover:underline cursor-pointer">
                          {r.name}
                        </Link>
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
                      {r.course_id ?? "-"}
                      {r.funding_category && (
                        <div className="text-xs text-slate-500">
                          {r.funding_category === "gov"
                            ? "Funded"
                            : r.funding_category === "self"
                              ? "Self-funded"
                              : r.funding_category}
                        </div>
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
                ))}
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
          onClick={onCannotReach}
          disabled={pending}
          className="px-3 py-1.5 text-xs font-semibold bg-amber-500 text-amber-950 rounded-md hover:bg-amber-400 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          {pending ? "Marking…" : "Mark Cannot reach"}
        </button>
        <button
          type="button"
          onClick={onLostClick}
          disabled={pending}
          className="px-3 py-1.5 text-xs font-semibold bg-rose-500 text-rose-950 rounded-md hover:bg-rose-400 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          Mark Lost…
        </button>
        <button
          type="button"
          onClick={onExportSelected}
          disabled={pending}
          className="px-3 py-1.5 text-xs font-semibold bg-slate-700 text-white rounded-md hover:bg-slate-600 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          Export selected
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

// Export the currently-filtered rows as a CSV. Lives client-side because the
// rows are already in memory; no extra round-trip.
function downloadCsv(rows: LeadRow[]) {
  const headers = [
    "Lead ID",
    "Name",
    "Email",
    "Course",
    "Funding",
    "Status",
    "Routed at",
    "Fastrack",
    "Callback pending",
  ];
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id.toString(),
        r.name,
        r.email ?? "",
        r.course_id ?? "",
        r.funding_category ?? "",
        STATUS_LABEL[r.status] ?? r.status,
        r.routed_at ?? "",
        r.has_fastrack ? "Yes" : "No",
        r.callback_pending ? "Yes" : "No",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const csv = lines.join("\r\n");
  // BOM so Excel opens UTF-8 cleanly without mangling non-ASCII names.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  a.download = `switchleads-leads-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvCell(value: string): string {
  // Quote if the value contains a quote, comma, or newline; double up internal quotes.
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function FilterPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors cursor-pointer ${
        active
          ? "bg-slate-900 text-white border-slate-900"
          : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:border-slate-300"
      }`}
    >
      {label}
      <span className={`ml-1.5 text-xs tabular-nums ${active ? "text-slate-300" : "text-slate-400"}`}>
        {count}
      </span>
    </button>
  );
}
