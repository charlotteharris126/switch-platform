// Right-hand sidebar on /provider/leads. quick stats + actionable
// "needs attention" list. Pure presentational; data is computed in
// the page from already-loaded rows so no extra round-trip.

import Link from "next/link";
import { DurationTimer } from "../duration-timer";
import { STATUS_LABEL, type LeadStatus } from "@/lib/lead-status";

interface StaleLead {
  id: number;
  name: string;
  routed_at: string | null;
  status: LeadStatus;
}

interface WeekStats {
  contacted: number;
  enrolled: number;
  lost: number;
  meetings_booked: number;
}

interface Props {
  open: number;
  inProgress: number;
  enrolledThisMonth: number;
  callbackPending: number;
  staleLeads: StaleLead[];
  weekStats: WeekStats;
}

export function LeadsSidebar({ open, inProgress, enrolledThisMonth, callbackPending, staleLeads, weekStats }: Props) {
  return (
    <aside className="space-y-4">
      {/* Snapshot tile */}
      <Card>
        <CardTitle>At a glance</CardTitle>
        <dl className="mt-3 space-y-2">
          {callbackPending > 0 && (
            <Stat label="Needs callback" value={callbackPending} tone="rose" emphasis />
          )}
          <Stat
            label="New (no contact)"
            value={open}
            tone={callbackPending > 0 ? "slate" : "rose"}
            emphasis={callbackPending === 0}
          />
          <Stat label="In progress" value={inProgress} tone="amber" />
          <Stat label="Enrolled this month" value={enrolledThisMonth} tone="emerald" />
        </dl>
      </Card>

      {/* Needs attention */}
      <Card>
        <CardTitle>Needs attention</CardTitle>
        <p className="text-xs text-slate-500 mt-1">Open leads with no contact attempt for over 7 days.</p>
        {staleLeads.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400 italic">Nothing to chase. Nice.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {staleLeads.map((l) => (
              <li key={l.id}>
                <Link
                  href={`/provider/leads/${l.id}`}
                  className="block p-2 -mx-2 rounded-md hover:bg-rose-50 transition-colors cursor-pointer"
                >
                  <p className="text-sm font-medium text-slate-900 truncate">{l.name}</p>
                  <p className="text-xs text-rose-700 mt-0.5 tabular-nums">
                    Sat for <DurationTimer since={l.routed_at} />
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* This week */}
      <Card>
        <CardTitle>This week</CardTitle>
        <dl className="mt-3 space-y-2">
          <Stat label="Contacted" value={weekStats.contacted} tone="slate" />
          <Stat label="Meetings booked" value={weekStats.meetings_booked} tone="blue" />
          <Stat label="Enrolled" value={weekStats.enrolled} tone="emerald" />
          <Stat label="Lost" value={weekStats.lost} tone="rose" />
        </dl>
      </Card>

      {/* Status legend */}
      <Card>
        <CardTitle>Status guide</CardTitle>
        <ul className="mt-3 space-y-1.5">
          {([
            ["open", "Routed, not yet contacted"],
            ["attempt_1_no_answer", "First call, no answer"],
            ["enrolment_meeting_booked", "Meeting in the diary"],
            ["enrolled", "On the course"],
            ["lost", "Won't proceed"],
            ["cannot_reach", "Tried, can't get through"],
          ] as Array<[LeadStatus, string]>).map(([s, hint]) => (
            <li key={s} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-slate-700 font-medium">{STATUS_LABEL[s]}</span>
              <span className="text-slate-500 text-right">{hint}</span>
            </li>
          ))}
        </ul>
      </Card>
    </aside>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      {children}
    </div>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</h2>
  );
}

function Stat({
  label,
  value,
  tone,
  emphasis,
}: {
  label: string;
  value: number;
  tone: "slate" | "amber" | "emerald" | "rose" | "blue";
  emphasis?: boolean;
}) {
  const valueClass: Record<string, string> = {
    slate: "text-slate-900",
    amber: "text-amber-700",
    emerald: "text-emerald-700",
    rose: "text-rose-700",
    blue: "text-blue-700",
  };
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-xs text-slate-600">{label}</dt>
      <dd className={`tabular-nums ${emphasis ? "text-2xl font-semibold" : "text-sm font-semibold"} ${valueClass[tone]}`}>
        {value}
      </dd>
    </div>
  );
}
