// Presentational view for the provider home page. Pure render — accepts
// pre-computed counts + links and outputs the welcome banner, action queue,
// pipeline pills, and recent activity list.
//
// Two callers:
//   1. /provider/page.tsx — real provider session, links target /provider/*
//   2. /admin/preview/[provider_id]/page.tsx — admin impersonation, links
//      target /preview/[provider_id]/* (preview navigation) and /admin/leads/*
//      (admin's own lead detail for click-through). The `linkPrefix` prop
//      threads through ActionCard / PipelinePill / Recent rows so preview
//      stays inside the admin surface.

import Link from "next/link";
import { DurationTimer } from "./duration-timer";
import { STATUS_LABEL, type LeadStatus } from "@/lib/lead-status";

interface RecentLead {
  id: number;
  name: string;
  course_id: string | null;
  routed_at: string | null;
  status: LeadStatus;
}

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

export interface SourceCount {
  source: string;
  count: number;
}

export interface HomeViewProps {
  providerLabel: string;
  greetingName: string;
  enrolledLast30d: number;
  counts: {
    open: number;
    attempts: number;
    meeting_booked: number;
  };
  callbackCount: number;
  fastrackReadyCount: number;
  staleAttemptCount: number;
  oldestCallbackSince: string | null;
  oldestFastrackSince: string | null;
  oldestOpenSince: string | null;
  oldestStaleAttemptSince: string | null;
  recentLeads: RecentLead[];
  // Where the provider's recent (last 30 days) leads came from. Top
  // sources by count. Each provider only sees their own breakdown.
  // Sources are utm_source values, with empty/null bucketed as "direct".
  sourceBreakdown: SourceCount[];
  // Where the action-queue, pipeline-pill, and "see all" links go. Real
  // provider pages pass "/provider", admin preview passes
  // "/preview/<provider_id>".
  leadsBase: string;
  // Where a recent-row click lands. Real provider passes
  // "/provider/leads/", admin preview passes "/admin/leads/" to drop the
  // operator into their own lead detail view.
  leadDetailPrefix: string;
}

export function ProviderHomeView({
  providerLabel,
  greetingName,
  enrolledLast30d,
  counts,
  callbackCount,
  fastrackReadyCount,
  staleAttemptCount,
  oldestCallbackSince,
  oldestFastrackSince,
  oldestOpenSince,
  oldestStaleAttemptSince,
  recentLeads,
  sourceBreakdown,
  leadsBase,
  leadDetailPrefix,
}: HomeViewProps) {
  const sourceTotal = sourceBreakdown.reduce((sum, s) => sum + s.count, 0);
  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold">
            {providerLabel}
          </p>
          <h1 className="text-2xl font-semibold text-slate-900 mt-1">
            Welcome back, {greetingName}
          </h1>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 shrink-0">
          <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
            Enrolments, past 30 days
          </p>
          <p className="text-3xl font-semibold tabular-nums text-slate-900 leading-none mt-1">
            {enrolledLast30d}
          </p>
        </div>
      </div>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
          Needs your attention
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <ActionCard
            href={`${leadsBase}/leads?status=fastrack`}
            tone="violet"
            count={fastrackReadyCount}
            label="fastrack leads"
            labelSingular="fastrack lead"
            hint="Cohort confirmed, ready to enrol"
            doneHint="No fastracks waiting"
            oldestSince={oldestFastrackSince}
          />
          <ActionCard
            href={`${leadsBase}/leads?status=callback`}
            tone="rose"
            count={callbackCount}
            label="callback requests"
            labelSingular="callback request"
            hint="Switchable flagged for follow-up"
            doneHint="No callbacks pending"
            oldestSince={oldestCallbackSince}
          />
          <ActionCard
            href={`${leadsBase}/leads?status=open`}
            tone="amber"
            count={counts.open}
            label="open leads never called"
            labelSingular="open lead never called"
            hint="No contact attempt yet"
            doneHint="Every open lead's been tried"
            oldestSince={oldestOpenSince}
          />
          <ActionCard
            href={`${leadsBase}/leads?status=action`}
            tone="orange"
            count={staleAttemptCount}
            label="call attempts need retrying"
            labelSingular="call attempt needs retrying"
            hint="Last call was 48h+ ago"
            doneHint="No stale attempts"
            oldestSince={oldestStaleAttemptSince}
          />
        </div>
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Your pipeline</h2>
          <Link
            href={`${leadsBase}/leads`}
            className="text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
          >
            See all leads &rarr;
          </Link>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <PipelinePill label="Open" value={counts.open} tone="slate" href={`${leadsBase}/leads?status=open`} />
          <PipelinePill label="Calling" value={counts.attempts} tone="amber" href={`${leadsBase}/leads?status=calling`} />
          <PipelinePill label="Meeting booked" value={counts.meeting_booked} tone="blue" href={`${leadsBase}/leads?status=meeting`} />
        </div>
      </section>

      {sourceTotal > 0 && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
            Where your last 30 days of leads came from
          </h2>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <ul className="space-y-2">
              {sourceBreakdown.map((s) => {
                const pct = sourceTotal > 0 ? Math.round((s.count / sourceTotal) * 100) : 0;
                return (
                  <li key={s.source} className="flex items-center gap-3 text-sm">
                    <span className="w-32 text-slate-700 capitalize truncate">{s.source}</span>
                    <span className="tabular-nums text-slate-900 w-10 text-right">{s.count}</span>
                    <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-slate-700"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="tabular-nums text-slate-500 text-xs w-10 text-right">{pct}%</span>
                  </li>
                );
              })}
            </ul>
            <p className="text-[10px] text-slate-400 mt-3">
              Source recorded at form submission (UTM tag). &quot;Direct&quot; means the learner found us without a tracked campaign.
            </p>
          </div>
        </section>
      )}

      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="flex items-baseline justify-between px-6 pt-5 pb-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Recently routed to you</h2>
            <p className="text-xs text-slate-500 mt-0.5">The last five leads. Click for full details.</p>
          </div>
          <Link
            href={`${leadsBase}/leads`}
            className="text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
          >
            See all &rarr;
          </Link>
        </div>
        {recentLeads.length === 0 ? (
          <p className="px-6 py-10 text-sm text-slate-500 text-center">
            No leads yet. New leads land here as they come in.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 border-t border-slate-100">
            {recentLeads.map((r) => (
              <li key={r.id} className="hover:bg-slate-50 transition-colors">
                <Link href={`${leadDetailPrefix}${r.id}`} className="flex items-center justify-between px-6 py-3 gap-3 cursor-pointer">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900 truncate">{r.name}</p>
                    <p className="text-xs text-slate-500 truncate">{r.course_id ?? "-"}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs text-slate-500 tabular-nums">
                      <DurationTimer since={r.routed_at} />
                    </span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${STATUS_TONE[r.status] ?? "bg-slate-100 text-slate-700 border-slate-200"}`}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ActionCard({
  href,
  tone,
  count,
  label,
  labelSingular,
  hint,
  doneHint,
  oldestSince,
}: {
  href: string;
  tone: "rose" | "violet" | "amber" | "orange";
  count: number;
  label: string;
  labelSingular: string;
  hint: string;
  doneHint: string;
  oldestSince?: string | null;
}) {
  const isDone = count === 0;
  const palette: Record<string, string> = {
    rose: "bg-rose-50 border-rose-200 hover:border-rose-300 hover:bg-rose-100 text-rose-900",
    violet: "bg-violet-50 border-violet-200 hover:border-violet-300 hover:bg-violet-100 text-violet-900",
    amber: "bg-amber-50 border-amber-200 hover:border-amber-300 hover:bg-amber-100 text-amber-900",
    orange: "bg-orange-50 border-orange-200 hover:border-orange-300 hover:bg-orange-100 text-orange-900",
    emerald: "bg-emerald-50 border-emerald-200 hover:border-emerald-300 hover:bg-emerald-100 text-emerald-900",
  };
  const numTone: Record<string, string> = {
    rose: "text-rose-700",
    violet: "text-violet-700",
    amber: "text-amber-700",
    orange: "text-orange-700",
    emerald: "text-emerald-700",
  };
  const effectiveTone = isDone ? "emerald" : tone;
  const displayLabel = count === 1 ? labelSingular : label;

  return (
    <Link
      href={href}
      className={`block p-4 rounded-xl border ${palette[effectiveTone]} transition-colors cursor-pointer`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className={`text-3xl font-semibold tabular-nums leading-none ${numTone[effectiveTone]}`}>
          {isDone ? "✓" : count}
        </p>
        <span className="text-xs font-semibold opacity-80">
          {isDone ? "All clear" : "Review →"}
        </span>
      </div>
      <p className="text-sm font-medium mt-2">{displayLabel}</p>
      <p className="text-xs opacity-75 mt-0.5">{isDone ? doneHint : hint}</p>
      {!isDone && oldestSince && (
        <p className="text-[11px] mt-1.5 font-medium opacity-80 tabular-nums">
          Oldest waiting{" "}
          <DurationTimer since={oldestSince} variant="full" />
        </p>
      )}
    </Link>
  );
}

function PipelinePill({
  label,
  value,
  tone,
  href,
}: {
  label: string;
  value: number;
  tone: "slate" | "amber" | "blue" | "emerald";
  href: string;
}) {
  const palette: Record<string, string> = {
    slate: "bg-white border-slate-200 hover:border-slate-300 hover:shadow-sm text-slate-900",
    amber: "bg-amber-50 border-amber-200 hover:border-amber-300 hover:shadow-sm text-amber-900",
    blue: "bg-blue-50 border-blue-200 hover:border-blue-300 hover:shadow-sm text-blue-900",
    emerald: "bg-emerald-50 border-emerald-200 hover:border-emerald-300 hover:shadow-sm text-emerald-900",
  };
  return (
    <Link
      href={href}
      className={`block p-4 rounded-xl border ${palette[tone]} transition-all cursor-pointer`}
    >
      <p className="text-xs uppercase tracking-wide font-semibold opacity-70">{label}</p>
      <p className="text-2xl font-semibold tabular-nums mt-1 leading-none">{value}</p>
    </Link>
  );
}
