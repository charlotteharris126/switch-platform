"use client";

// Month-grid calendar for the editorial pipeline. Posts cluster by
// publish_date and colour-code by status (draft / scheduled / published /
// archived). Clicking a chip opens the post in the editor. The grid
// understands which scheduled posts are overdue (publish_date < today AND
// status='scheduled') — the daily cron from migration 0166 catches these
// automatically but the visual flag is useful in case the cron is paused.

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

type PostStatus = "draft" | "scheduled" | "published" | "archived";

export type CalendarEvent = {
  id: number;
  slug: string;
  title: string;
  status: PostStatus;
  publish_date: string;
  category_id: string | null;
};

const STATUS_STYLE: Record<PostStatus, { bg: string; text: string; border: string; dot: string; label: string }> = {
  draft:     { bg: "bg-[#fcefd6]", text: "text-[#92651c]", border: "border-[#f0d99c]", dot: "bg-[#92651c]", label: "Draft" },
  scheduled: { bg: "bg-[#e3eef5]", text: "text-[#2a5778]", border: "border-[#c6dceb]", dot: "bg-[#2a5778]", label: "Scheduled" },
  published: { bg: "bg-[#dcefea]", text: "text-[#1f5f5e]", border: "border-[#bcdfd8]", dot: "bg-[#1f5f5e]", label: "Published" },
  archived:  { bg: "bg-[#eee9e0]", text: "text-[#5a6a72]", border: "border-[#d4ccc0]", dot: "bg-[#5a6a72]", label: "Archived" },
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function isoDate(d: Date): string {
  // Local-time YYYY-MM-DD without UTC drift.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function buildMonthCells(view: Date): Date[] {
  // 6-row grid starting Monday. Same shape every month for consistent layout.
  const first = startOfMonth(view);
  // JS getDay: Sunday=0, Monday=1, …, Saturday=6 — re-base so Monday=0.
  const offsetToMonday = (first.getDay() + 6) % 7;
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - offsetToMonday);

  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push(d);
  }
  return cells;
}

export function CalendarGrid({ events }: { events: CalendarEvent[] }) {
  const [view, setView] = useState<Date>(() => {
    // If anything's scheduled in the future, default to the earliest future
    // month; otherwise the current month. Saves a click for new users.
    const future = events
      .filter((e) => e.status === "scheduled")
      .map((e) => new Date(e.publish_date))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (future && future > new Date()) {
      return startOfMonth(future);
    }
    return startOfMonth(new Date());
  });

  const today = useMemo(() => isoDate(new Date()), []);
  const cells = useMemo(() => buildMonthCells(view), [view]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const key = e.publish_date.slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    // Sort each day's stack: scheduled first (most actionable), then drafts,
    // then published, then archived. Stable secondary sort by title.
    const order: Record<PostStatus, number> = { scheduled: 0, draft: 1, published: 2, archived: 3 };
    for (const arr of map.values()) {
      arr.sort((a, b) => order[a.status] - order[b.status] || a.title.localeCompare(b.title));
    }
    return map;
  }, [events]);

  function monthLabel(d: Date) {
    return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }

  // Stats for the current month view.
  const monthStats = useMemo(() => {
    const y = view.getFullYear();
    const m = view.getMonth();
    const inMonth = events.filter((e) => {
      const d = new Date(e.publish_date);
      return d.getFullYear() === y && d.getMonth() === m;
    });
    return {
      total: inMonth.length,
      drafts: inMonth.filter((e) => e.status === "draft").length,
      scheduled: inMonth.filter((e) => e.status === "scheduled").length,
      published: inMonth.filter((e) => e.status === "published").length,
    };
  }, [events, view]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setView((v) => addMonths(v, -1))}
          >
            ← Prev
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setView(startOfMonth(new Date()))}
          >
            Today
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setView((v) => addMonths(v, 1))}
          >
            Next →
          </Button>
        </div>
        <div className="text-xl font-extrabold text-[#11242e]">{monthLabel(view)}</div>
        <div className="text-xs text-[#5a6a72]">
          {monthStats.total} this month · {monthStats.scheduled} scheduled · {monthStats.published} live · {monthStats.drafts} drafts
        </div>
      </div>

      <div className="flex items-center gap-3 text-[11px] text-[#5a6a72]">
        <LegendDot status="draft" />
        <LegendDot status="scheduled" />
        <LegendDot status="published" />
        <LegendDot status="archived" />
        <span className="ml-auto">Click any chip to edit · click "+ Schedule" on an empty day to draft a post on that date</span>
      </div>

      <div className="rounded-2xl border border-[#e5dfd8] bg-white overflow-hidden">
        <div className="grid grid-cols-7 bg-[#f5f2eb] border-b border-[#e5dfd8]">
          {WEEKDAYS.map((d) => (
            <div
              key={d}
              className="px-3 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[#5a6a72] text-center"
            >
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 grid-rows-6">
          {cells.map((d, i) => {
            const dateKey = isoDate(d);
            const inMonth = d.getMonth() === view.getMonth();
            const isToday = dateKey === today;
            const dayEvents = eventsByDate.get(dateKey) ?? [];
            return (
              <div
                key={i}
                className={`min-h-[110px] border-r border-b border-[#e5dfd8] last:border-r-0 p-2 flex flex-col gap-1 ${
                  inMonth ? "bg-white" : "bg-[#fafaf6] text-[#aaa]"
                } ${isToday ? "ring-2 ring-inset ring-[#287271]" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <div
                    className={`text-xs font-semibold ${
                      isToday ? "text-[#287271]" : inMonth ? "text-[#11242e]" : "text-[#aaa]"
                    }`}
                  >
                    {d.getDate()}
                  </div>
                  {inMonth && dayEvents.length === 0 && (
                    <Link
                      href={`/admin/blog/new?date=${dateKey}`}
                      className="text-[10px] text-[#5a6a72] hover:text-[#287271] opacity-0 hover:opacity-100 focus:opacity-100"
                      title="Draft a post scheduled for this day"
                    >
                      + Schedule
                    </Link>
                  )}
                </div>
                <div className="flex flex-col gap-1 overflow-hidden">
                  {dayEvents.slice(0, 4).map((e) => {
                    const overdue = e.status === "scheduled" && dateKey < today;
                    return (
                      <PostChip key={e.id} event={e} overdue={overdue} />
                    );
                  })}
                  {dayEvents.length > 4 && (
                    <div className="text-[10px] text-[#5a6a72] pl-1">
                      +{dayEvents.length - 4} more
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LegendDot({ status }: { status: PostStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`h-2 w-2 rounded-full ${s.dot}`} />
      <span>{s.label}</span>
    </span>
  );
}

function PostChip({ event, overdue }: { event: CalendarEvent; overdue: boolean }) {
  const style = STATUS_STYLE[event.status];
  return (
    <Link
      href={`/admin/blog/${event.slug}/edit`}
      className={`block text-[10px] leading-tight px-1.5 py-1 rounded border truncate ${style.bg} ${style.text} ${style.border} hover:brightness-95 ${
        overdue ? "ring-1 ring-[#8a2e1a]" : ""
      }`}
      title={`${event.title} (${event.status}${overdue ? " · OVERDUE" : ""})`}
    >
      <span className="font-semibold">{event.title}</span>
      {overdue && <span className="ml-1 text-[#8a2e1a] font-bold">!</span>}
    </Link>
  );
}
