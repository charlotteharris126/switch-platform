// Right-hand sidebar on /provider/leads.
//
// Categories now mirror the filter pills above the table 1:1, so a click
// in the sidebar lands on a list view with the same count. Old "Needs
// attention" widget retired since the elevated Action banner above the
// table covers stale-lead surfacing.

import Link from "next/link";
import { STATUS_LABEL, type LeadStatus } from "@/lib/lead-status";

interface WeekStats {
  contacted: number;
  enrolled: number;
  lost: number;
  meetings_booked: number;
}

interface Props {
  open: number;
  // Overdue rows: SLA-breached. Sits above Fresh in the snapshot when > 0.
  // Optional so admin preview pages that don't compute it still render.
  overdue?: number;
  calling: number;
  meetingBooked: number;
  enrolledThisMonth: number;
  callbackPending: number;
  weekStats: WeekStats;
  // 'learner' (default) or 'employer_apprenticeship'. When employer, swap
  // the snapshot, this-week stats, and status guide for B2B-shaped
  // equivalents. Defaults to learner to preserve existing behaviour for
  // EMS/CD/WYK.
  leadType?: "learner" | "employer_apprenticeship";
  employerStats?: {
    engaged: number;
    in_progress: number;
    signed: number;
    signed_this_month: number;
  };
  // Base path for the snapshot StatLinks. Defaults to /provider/leads for
  // the live provider portal. /admin/preview/[id]/leads passes its own
  // scoped path so sidebar clicks stay inside the preview context.
  leadsHrefBase?: string;
}

export function LeadsSidebar({
  open,
  overdue = 0,
  calling,
  meetingBooked,
  enrolledThisMonth,
  callbackPending,
  weekStats,
  leadType = "learner",
  employerStats,
  leadsHrefBase = "/provider/leads",
}: Props) {
  const isEmployer = leadType === "employer_apprenticeship";
  if (isEmployer) {
    const es = employerStats ?? { engaged: 0, in_progress: 0, signed: 0, signed_this_month: 0 };
    return (
      <aside className="space-y-4">
        <Card>
          <CardTitle>At a glance</CardTitle>
          <div className="mt-3 space-y-0.5">
            <StatLink href={`${leadsHrefBase}?status=open`} label="Open" value={open} tone="rose" emphasis />
            <StatLink href={`${leadsHrefBase}?status=engaged`} label="Engaged" value={es.engaged} tone="blue" />
            <StatLink href={`${leadsHrefBase}?status=in_progress`} label="In progress" value={es.in_progress} tone="amber" />
            <StatLink href={`${leadsHrefBase}?status=signed`} label="Signed this month" value={es.signed_this_month} tone="emerald" />
          </div>
        </Card>

        <Card>
          <CardTitle>This week</CardTitle>
          <div className="mt-3 space-y-1">
            <Stat label="New leads" value={weekStats.contacted} tone="slate" />
            <Stat label="Signed" value={weekStats.enrolled} tone="emerald" />
            <Stat label="Not signed" value={weekStats.lost} tone="rose" />
          </div>
        </Card>

        <Card>
          <CardTitle>Status guide</CardTitle>
          <ul className="mt-3 space-y-1.5">
            {([
              ["open", "Routed, not yet engaged"],
              ["engaged", "First contact made"],
              ["in_progress", "Deal moving, not yet signed"],
              ["signed", "Apprenticeship agreement executed"],
              ["not_signed", "Won't proceed"],
              ["presumed_employer_signed", "Auto-flipped after 60 days"],
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
  return (
    <aside className="space-y-4">
      {/* Snapshot. Every row clicks through to the matching filter. */}
      <Card>
        <CardTitle>At a glance</CardTitle>
        <div className="mt-3 space-y-0.5">
          <StatLink
            href={`${leadsHrefBase}?status=fresh`}
            label="New"
            value={open}
            tone="rose"
            emphasis
          />
          {overdue > 0 && (
            <StatLink
              href={`${leadsHrefBase}?status=overdue`}
              label="Overdue"
              value={overdue}
              tone="rose"
            />
          )}
          {callbackPending > 0 && (
            <StatLink
              href={`${leadsHrefBase}?status=callback`}
              label="Needs callback"
              value={callbackPending}
              tone="rose"
            />
          )}
          <StatLink
            href={`${leadsHrefBase}?status=calling`}
            label="Calling"
            value={calling}
            tone="amber"
          />
          <StatLink
            href={`${leadsHrefBase}?status=meeting`}
            label="Meeting booked"
            value={meetingBooked}
            tone="blue"
          />
          <StatLink
            href={`${leadsHrefBase}?status=enrolled`}
            label="Enrolled this month"
            value={enrolledThisMonth}
            tone="emerald"
          />
        </div>
      </Card>

      {/* This week — time-based, complements the status snapshot above */}
      <Card>
        <CardTitle>This week</CardTitle>
        <div className="mt-3 space-y-1">
          <Stat label="Contacted" value={weekStats.contacted} tone="slate" />
          <Stat label="Meetings booked" value={weekStats.meetings_booked} tone="blue" />
          <Stat label="Enrolled" value={weekStats.enrolled} tone="emerald" />
          <Stat label="Lost" value={weekStats.lost} tone="rose" />
        </div>
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

const TONE_TEXT: Record<string, string> = {
  slate: "text-slate-900",
  amber: "text-amber-700",
  emerald: "text-emerald-700",
  rose: "text-rose-700",
  blue: "text-blue-700",
};

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
  return (
    <div className="flex items-baseline justify-between gap-2 px-1 py-1">
      <span className="text-xs text-slate-600">{label}</span>
      <span
        className={`tabular-nums ${
          emphasis ? "text-2xl font-semibold" : "text-sm font-semibold"
        } ${TONE_TEXT[tone]}`}
      >
        {value}
      </span>
    </div>
  );
}

function StatLink({
  href,
  label,
  value,
  tone,
  emphasis,
}: {
  href: string;
  label: string;
  value: number;
  tone: "slate" | "amber" | "emerald" | "rose" | "blue";
  emphasis?: boolean;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-2 px-2 -mx-2 py-2 rounded-md hover:bg-slate-100 active:bg-slate-200 cursor-pointer transition-colors group border border-transparent hover:border-slate-200"
    >
      <span className="text-xs text-slate-700 group-hover:text-slate-900 group-hover:font-semibold transition-all">
        {label}
      </span>
      <span
        className={`tabular-nums ${
          emphasis ? "text-2xl font-semibold" : "text-sm font-semibold"
        } ${TONE_TEXT[tone]}`}
      >
        {value}
      </span>
    </Link>
  );
}
