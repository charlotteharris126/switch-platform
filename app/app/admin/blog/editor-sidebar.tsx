"use client";

// Right-rail companion to PostForm. Two stacked surfaces:
//   - "Checklist" tab — the SEO checklist (default tab, always-on quality bar)
//   - "Preview" tab — live markdown render of the body field, styled to
//     loosely match the live blog template
// Tabbed so Charlotte can flip between writing for SEO and proof-reading
// flow without leaving the editor.

import { useMemo, useState } from "react";
import { Marked } from "marked";
import DOMPurify from "isomorphic-dompurify";
import type { SeoCheck, CheckStatus, CheckGroup } from "./seo-checks";
import { checkSeoSummary } from "./seo-checks";

const GROUP_LABELS: Record<CheckGroup, string> = {
  required: "Required",
  keyword_usage: "Keyword placement",
  on_page: "On-page SEO",
  readability: "Readability",
  aeo: "AEO + AI retrieval",
  social: "Social + media",
  defaults: "What will actually render",
};

const GROUP_ORDER: CheckGroup[] = ["required", "keyword_usage", "on_page", "readability", "aeo", "social", "defaults"];

const STATUS_STYLE: Record<CheckStatus, { dot: string; text: string; bg: string }> = {
  pass: { dot: "bg-[#1f5f5e]", text: "text-[#1f5f5e]", bg: "bg-[#dcefea]" },
  warn: { dot: "bg-[#92651c]", text: "text-[#92651c]", bg: "bg-[#fcefd6]" },
  fail: { dot: "bg-[#8a2e1a]", text: "text-[#8a2e1a]", bg: "bg-[#f7d8d0]" },
  info: { dot: "bg-[#5a6a72]", text: "text-[#5a6a72]", bg: "bg-[#eee9e0]" },
};

// Stable marked instance — reuse across renders so we don't re-parse config.
// GFM for tables + line-break preservation off (matches the build-side parser).
const marked = new Marked({ gfm: true, breaks: false });

type Tab = "checklist" | "preview";

interface Props {
  checks: SeoCheck[];
  title: string;
  dek: string;
  body: string;
}

export function EditorSidebar({ checks, title, dek, body }: Props) {
  const [tab, setTab] = useState<Tab>("checklist");
  const summary = checkSeoSummary(checks);

  return (
    <aside className="space-y-3 sticky top-4 self-start">
      <div className="rounded-2xl border border-[#e5dfd8] bg-white overflow-hidden">
        <div className="flex border-b border-[#e5dfd8]">
          <TabButton active={tab === "checklist"} onClick={() => setTab("checklist")}>
            <span>SEO</span>
            <SummaryDots summary={summary} />
          </TabButton>
          <TabButton active={tab === "preview"} onClick={() => setTab("preview")}>
            <span>Preview</span>
          </TabButton>
        </div>

        {tab === "checklist" && <ChecklistPanel checks={checks} summary={summary} />}
        {tab === "preview" && <PreviewPanel title={title} dek={dek} body={body} />}
      </div>
    </aside>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.14em] transition-colors flex items-center justify-center gap-2 ${
        active
          ? "bg-white text-[#11242e] border-b-2 border-[#287271] -mb-px"
          : "bg-[#f5f2eb] text-[#5a6a72] hover:text-[#11242e]"
      }`}
    >
      {children}
    </button>
  );
}

function SummaryDots({ summary }: { summary: ReturnType<typeof checkSeoSummary> }) {
  return (
    <span className="flex gap-1 items-center text-[10px] font-bold normal-case tracking-normal">
      {summary.fail > 0 && (
        <span className="inline-flex items-center gap-0.5 text-[#8a2e1a]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#8a2e1a]" />
          {summary.fail}
        </span>
      )}
      {summary.warn > 0 && (
        <span className="inline-flex items-center gap-0.5 text-[#92651c]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#92651c]" />
          {summary.warn}
        </span>
      )}
      {summary.fail === 0 && summary.warn === 0 && (
        <span className="inline-flex items-center gap-0.5 text-[#1f5f5e]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#1f5f5e]" />
          OK
        </span>
      )}
    </span>
  );
}

function ChecklistPanel({
  checks,
  summary,
}: {
  checks: SeoCheck[];
  summary: ReturnType<typeof checkSeoSummary>;
}) {
  const byGroup = new Map<CheckGroup, SeoCheck[]>();
  for (const c of checks) {
    if (!byGroup.has(c.group)) byGroup.set(c.group, []);
    byGroup.get(c.group)!.push(c);
  }

  return (
    <div className="p-4 max-h-[calc(100vh-160px)] overflow-y-auto">
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
  );
}

function PreviewPanel({ title, dek, body }: { title: string; dek: string; body: string }) {
  // Parse on every keystroke — marked is fast (<5ms for typical posts).
  // Memo'd against body so unchanged renders are cheap. Title + dek update
  // immediately (no markdown parse needed).
  const html = useMemo(() => {
    if (!body.trim()) return "";
    // Shortcodes won't expand in admin preview (they're build-time only) —
    // show them as labelled placeholder blocks so Charlotte sees the layout
    // intent without the placeholder text leaking into the proof read.
    const massaged = body
      .replace(/\{\{related-posts\}\}/g, '<div class="ed-placeholder">[related posts]</div>')
      .replace(/\{\{recommended-next\}\}/g, '<div class="ed-placeholder">[recommended-next callout]</div>')
      .replace(/\{\{pull-quote:\s*([^}]+)\}\}/g, '<blockquote class="ed-pullquote">$1</blockquote>')
      .replace(/\{\{course-finder\}\}/g, '<div class="ed-placeholder">[course-finder CTA]</div>')
      .replace(/\{\{newsletter\}\}/g, '<div class="ed-placeholder">[newsletter signup]</div>')
      .replace(/\{\{course-card\s+slug=([a-z0-9-]+)\}\}/g, '<div class="ed-placeholder">[course-card: $1]</div>');
    // DOMPurify strips <script>, <iframe>, event handlers, and other XSS
    // vectors from the rendered HTML before injection. Defence-in-depth:
    // Tiptap is configured html: false so the body shouldn't contain raw
    // HTML anyway, but if anything ever does (markdown imports, agent
    // writes, paste-from-Word), the preview tab stays safe.
    const rawHtml = marked.parse(massaged) as string;
    return DOMPurify.sanitize(rawHtml);
  }, [body]);

  return (
    <div className="p-4 max-h-[calc(100vh-160px)] overflow-y-auto">
      {!title && !body.trim() ? (
        <p className="text-[11px] text-[#5a6a72] italic">
          Start writing to see the live preview.
        </p>
      ) : (
        <article
          className="text-[#11242e] text-[13px] leading-relaxed
            [&_h1]:text-lg [&_h1]:font-extrabold [&_h1]:mt-0 [&_h1]:mb-2 [&_h1]:leading-tight
            [&_.ed-dek]:text-[12px] [&_.ed-dek]:text-[#5a6a72] [&_.ed-dek]:mb-4 [&_.ed-dek]:italic
            [&_p]:my-3 [&_p]:leading-relaxed
            [&_h2]:text-[15px] [&_h2]:font-extrabold [&_h2]:text-[#11242e] [&_h2]:mt-5 [&_h2]:mb-2
            [&_h3]:text-[13px] [&_h3]:font-bold [&_h3]:text-[#11242e] [&_h3]:mt-4 [&_h3]:mb-1
            [&_a]:text-[#287271] [&_a]:underline-offset-2 hover:[&_a]:underline
            [&_strong]:font-bold [&_strong]:text-[#11242e]
            [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ul_li]:my-1
            [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol_li]:my-1
            [&_blockquote]:border-l-2 [&_blockquote]:border-[#287271] [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:my-3 [&_blockquote]:text-[#11242e]
            [&_.ed-pullquote]:bg-[#fcf7e6] [&_.ed-pullquote]:border-l-4 [&_.ed-pullquote]:border-[#E9C46A] [&_.ed-pullquote]:py-2 [&_.ed-pullquote]:px-3 [&_.ed-pullquote]:font-extrabold [&_.ed-pullquote]:not-italic
            [&_.ed-placeholder]:bg-[#f5f2eb] [&_.ed-placeholder]:border [&_.ed-placeholder]:border-dashed [&_.ed-placeholder]:border-[#d4ccc0] [&_.ed-placeholder]:rounded-md [&_.ed-placeholder]:p-2 [&_.ed-placeholder]:text-[10px] [&_.ed-placeholder]:text-[#5a6a72] [&_.ed-placeholder]:text-center [&_.ed-placeholder]:my-3
            [&_code]:bg-[#f5f2eb] [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[11px] [&_code]:font-mono
            [&_pre]:bg-[#11242e] [&_pre]:text-white [&_pre]:p-3 [&_pre]:rounded-md [&_pre]:overflow-x-auto [&_pre]:my-3 [&_pre]:text-[11px] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-white
            [&_hr]:my-4 [&_hr]:border-[#e5dfd8]
            [&_img]:rounded-md [&_img]:my-3"
        >
          {title && <h1>{title}</h1>}
          {dek && <p className="ed-dek">{dek}</p>}
          <div dangerouslySetInnerHTML={{ __html: html }} />
        </article>
      )}
    </div>
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
