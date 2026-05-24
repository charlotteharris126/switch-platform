"use client";

import type { SeoCheck, CheckStatus, CheckGroup } from "./seo-checks";
import { checkSeoSummary } from "./seo-checks";

const GROUP_LABELS: Record<CheckGroup, string> = {
  required: "Required",
  on_page: "On-page SEO",
  social: "Social + media",
  defaults: "What will actually render",
};

const GROUP_ORDER: CheckGroup[] = ["required", "on_page", "social", "defaults"];

const STATUS_STYLE: Record<CheckStatus, { dot: string; text: string; bg: string }> = {
  pass: { dot: "bg-[#1f5f5e]", text: "text-[#1f5f5e]", bg: "bg-[#dcefea]" },
  warn: { dot: "bg-[#92651c]", text: "text-[#92651c]", bg: "bg-[#fcefd6]" },
  fail: { dot: "bg-[#8a2e1a]", text: "text-[#8a2e1a]", bg: "bg-[#f7d8d0]" },
  info: { dot: "bg-[#5a6a72]", text: "text-[#5a6a72]", bg: "bg-[#eee9e0]" },
};

export function SeoChecklist({ checks }: { checks: SeoCheck[] }) {
  const summary = checkSeoSummary(checks);
  const byGroup = new Map<CheckGroup, SeoCheck[]>();
  for (const c of checks) {
    if (!byGroup.has(c.group)) byGroup.set(c.group, []);
    byGroup.get(c.group)!.push(c);
  }

  return (
    <aside className="space-y-4">
      <div className="rounded-2xl border border-[#e5dfd8] bg-white p-4 sticky top-4">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a6a72] mb-3">
          SEO checklist
        </h3>

        <div className="flex gap-2 text-[11px] font-semibold mb-4">
          <SummaryPill count={summary.pass} status="pass" label="OK" />
          <SummaryPill count={summary.warn} status="warn" label="Warn" />
          <SummaryPill count={summary.fail} status="fail" label="Fix" />
        </div>

        {summary.blockingPublish && (
          <div className="rounded-md border border-[#e9b3a4] bg-[#f7d8d0] text-[#8a2e1a] px-3 py-2 text-[11px] mb-4">
            <strong>Blocking issues.</strong> Fix the red items before flipping to scheduled / published.
          </div>
        )}

        <div className="space-y-4">
          {GROUP_ORDER.map((group) => {
            const items = byGroup.get(group);
            if (!items || items.length === 0) return null;
            return (
              <div key={group}>
                <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#5a6a72] mb-2">
                  {GROUP_LABELS[group]}
                </div>
                <ul className="space-y-2">
                  {items.map((c) => (
                    <li key={c.id} className="flex gap-2 text-[11px]">
                      <span className={`mt-1.5 h-2 w-2 rounded-full flex-shrink-0 ${STATUS_STYLE[c.status].dot}`} />
                      <div className="leading-snug">
                        <span className="font-semibold text-[#11242e]">{c.label}</span>
                        <span className="text-[#5a6a72]"> — {c.message}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

function SummaryPill({ count, status, label }: { count: number; status: CheckStatus; label: string }) {
  const style = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-md ${style.bg} ${style.text}`}>
      <span className="font-extrabold">{count}</span>
      <span>{label}</span>
    </span>
  );
}
