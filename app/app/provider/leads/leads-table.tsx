"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { DurationTimer } from "../duration-timer";
import { STATUS_LABEL, type LeadStatus } from "@/lib/lead-status";

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
  has_fastrack: boolean;
  callback_pending: boolean;
}

export type Filter =
  | "all"
  | "callback"
  | "fastrack"
  | "open"
  | "calling"
  | "meeting"
  | "enrolled"
  | "cold";

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

const CALLING = new Set<LeadStatus>([
  "attempt_1_no_answer",
  "attempt_2_no_answer",
  "attempt_3_no_answer",
]);
const ENROLLED = new Set<LeadStatus>(["enrolled", "presumed_enrolled"]);
const COLD = new Set<LeadStatus>(["lost", "cannot_reach"]);

interface Props {
  rows: LeadRow[];
  initialFilter?: Filter;
}

export function LeadsTable({ rows, initialFilter = "all" }: Props) {
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    let open = 0;
    let calling = 0;
    let meeting = 0;
    let enrolled = 0;
    let cold = 0;
    let callback = 0;
    let fastrack = 0;
    for (const r of rows) {
      if (r.callback_pending) callback += 1;
      if (r.has_fastrack) fastrack += 1;
      if (r.status === "open") open += 1;
      if (CALLING.has(r.status)) calling += 1;
      if (r.status === "enrolment_meeting_booked") meeting += 1;
      if (ENROLLED.has(r.status)) enrolled += 1;
      if (COLD.has(r.status)) cold += 1;
    }
    return { all: rows.length, callback, fastrack, open, calling, meeting, enrolled, cold };
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const subset = rows.filter((r) => {
      if (filter === "all") {
        // pass
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
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
              <tr>
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
                    r.callback_pending
                      ? "bg-rose-50/50"
                      : r.has_fastrack
                        ? "bg-violet-50/40"
                        : ""
                  }`}
                >
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
