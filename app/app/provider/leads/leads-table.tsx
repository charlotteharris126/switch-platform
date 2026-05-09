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
}

type Filter = "all" | "open" | "in_progress" | "settled" | LeadStatus;

const FILTER_DEFS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "settled", label: "Settled" },
];

const IN_PROGRESS = new Set<LeadStatus>([
  "attempt_1_no_answer",
  "attempt_2_no_answer",
  "attempt_3_no_answer",
  "enrolment_meeting_booked",
]);
const SETTLED = new Set<LeadStatus>(["enrolled", "presumed_enrolled", "lost", "cannot_reach"]);

interface Props {
  rows: LeadRow[];
  initialFilter?: Filter;
}

export function LeadsTable({ rows, initialFilter = "all" }: Props) {
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    let open = 0;
    let inProgress = 0;
    let settled = 0;
    for (const r of rows) {
      if (r.status === "open") open += 1;
      if (IN_PROGRESS.has(r.status)) inProgress += 1;
      if (SETTLED.has(r.status)) settled += 1;
    }
    return { all: rows.length, open, in_progress: inProgress, settled };
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "all") {
        // pass
      } else if (filter === "open") {
        if (r.status !== "open") return false;
      } else if (filter === "in_progress") {
        if (!IN_PROGRESS.has(r.status)) return false;
      } else if (filter === "settled") {
        if (!SETTLED.has(r.status)) return false;
      } else {
        if (r.status !== filter) return false;
      }
      if (q.length > 0) {
        const haystack = `${r.name} ${r.email ?? ""} ${r.course_id ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
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
        <div className="relative">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or course"
            className="border border-slate-300 rounded-md pl-3 pr-3 py-1.5 text-sm w-56 focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
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
                <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/provider/leads/${r.id}`} className="text-slate-900 font-medium hover:underline">
                      {r.name}
                    </Link>
                    {r.email && <div className="text-xs text-slate-500">{r.email}</div>}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {r.course_id ?? "—"}
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
      className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
        active
          ? "bg-slate-900 text-white border-slate-900"
          : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
      }`}
    >
      {label}
      <span className={`ml-1.5 text-xs tabular-nums ${active ? "text-slate-300" : "text-slate-400"}`}>
        {count}
      </span>
    </button>
  );
}
