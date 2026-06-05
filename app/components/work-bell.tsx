"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getWorkNotificationsAction, type NotifResult } from "@/app/admin/work/actions";

// Work Hub notifications. Polls on load (no realtime in v1). Shows a badge +
// a panel grouped by New / Due today / Overdue / Due soon / Stalled / Review.
export function WorkBell() {
  const [data, setData] = useState<NotifResult | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    getWorkNotificationsAction().then((r) => { if (alive) setData(r); });
    return () => { alive = false; };
  }, []);

  const total = data?.ok ? data.total : 0;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative flex items-center justify-center w-8 h-8 rounded-full text-white/70 hover:text-white hover:bg-white/10 transition-colors"
        aria-label="Notifications"
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {total > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-[#cd8b76] text-white text-[10px] font-bold flex items-center justify-center">
            {total}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-2 w-80 max-h-[70vh] overflow-y-auto z-50 bg-white rounded-xl shadow-2xl border border-[#e0dacf] text-[#11242e] p-3">
            <div className="flex items-center justify-between mb-2 px-1">
              <span className="text-[11px] font-bold uppercase tracking-[1px] text-[#5a6a72]">Needs attention</span>
              <Link href="/admin/work" onClick={() => setOpen(false)} className="text-[11px] text-[#cd8b76] hover:underline">Open Work</Link>
            </div>

            {!data && <p className="text-sm text-[#5a6a72] px-1 py-2">Loading…</p>}
            {data && !data.ok && <p className="text-sm text-rose-600 px-1 py-2">Couldn&apos;t load.</p>}
            {data && data.ok && data.buckets.length === 0 && (
              <p className="text-sm text-[#5a6a72] px-1 py-3">All clear — nothing needs you.</p>
            )}

            {data && data.ok && data.buckets.map((b) => (
              <div key={b.key} className="mb-2.5 last:mb-0">
                <Link
                  href={`/admin/work?view=${b.key}`}
                  onClick={() => setOpen(false)}
                  className="flex items-center justify-between px-1 mb-1 group"
                >
                  <span className="text-xs font-semibold text-[#11242e] group-hover:text-[#cd8b76]">{b.label}</span>
                  <span className="text-[11px] font-bold text-[#5a6a72] tabular-nums">{b.tasks.length}</span>
                </Link>
                <ul className="space-y-0.5">
                  {b.tasks.slice(0, 6).map((t) => (
                    <li key={t.id}>
                      <Link href="/admin/work" onClick={() => setOpen(false)}
                        className="block text-xs text-[#5a6a72] hover:text-[#11242e] truncate px-1 py-0.5 rounded hover:bg-[#faf8f4]">
                        {t.title}
                      </Link>
                    </li>
                  ))}
                  {b.tasks.length > 6 && <li className="text-[11px] text-[#5a6a72] px-1">+{b.tasks.length - 6} more</li>}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
