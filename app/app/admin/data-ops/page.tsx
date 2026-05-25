// /admin/data-ops — index of data-operation panels + paste-ready SQL recipes
// for jobs that don't have a UI yet.
//
// History note: between 2026-05-24 and 2026-05-25 this directory briefly
// hosted three React-based bulk-resync panels (EMS segment, per-course,
// EMS YAML port). Two of them tripped a Next.js "unexpected response from
// server" error during the EMS resync push — root cause was a Server
// Action / Edge Function timeout interaction that needs framework-level
// debugging. The reliable fallback is pg_net.http_post from the SQL
// editor, recipes below. Panels deleted to avoid future operators
// reaching for them and hitting the same wall.

import Link from "next/link";
import { PageHeader } from "@/components/page-header";

type ToolStatus = "ongoing" | "throwaway";
type Tool = {
  href: string;
  title: string;
  description: string;
  status: ToolStatus;
  context?: string;
};

const TOOLS: Tool[] = [
  {
    href: "/admin/data-ops/ai-assist-log",
    title: "AI assist log + cost rollup",
    description:
      "Every Suggest button click in /admin/blog logs here with cost, latency, model, and any error. Today / 7-day / 30-day / lifetime spend totals.",
    status: "ongoing",
    context:
      "Backed by editorial.ai_assist_log. Rate limit: 30 calls/min, 200 calls/day, enforced inside the EF.",
  },
  {
    href: "/admin/data-ops/port-blog-yaml",
    title: "Port launch blog drafts into the CMS",
    description:
      "Loads the 4 launch-set YAML drafts (career-change, pensions, starting-a-business, what-funded-training-means) into editorial.posts so they're editable in the CMS.",
    status: "throwaway",
    context:
      "Pre-CMS-cutover plumbing (2026-05-24). Idempotent. Deletes cleanly once the legacy YAML port has been validated and the editorial.posts source-of-truth is live.",
  },
];

const STATUS_STYLE: Record<ToolStatus, { pill: string; label: string }> = {
  ongoing: { pill: "bg-[#dcefea] text-[#1f5f5e] border-[#bcdfd8]", label: "Ongoing" },
  throwaway: { pill: "bg-[#eee9e0] text-[#5a6a72] border-[#d4ccc0]", label: "Throwaway" },
};

const COURSE_RESYNC_SQL = `-- Resync every contact whose canonical course is the picked slug.
-- Use after closing a course (accepting_applications: false on the YAML +
-- switchable-site rebuild) so SW_COURSE_OPEN=false lands on existing
-- contacts and Wren's N1-N3 course-closed exit fires.
-- Replace <course-slug> below with the page slug (e.g. counselling-skills-tees-valley).
SELECT net.http_post(
  url := 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/admin-brevo-resync',
  headers := jsonb_build_object(
    'x-audit-key', public.get_shared_secret('AUDIT_SHARED_SECRET'),
    'content-type', 'application/json'
  ),
  body := jsonb_build_object(
    'submissionIds', (
      SELECT COALESCE(array_agg(id), ARRAY[]::INT[])
      FROM leads.submissions
      WHERE course_id = '<course-slug>'
        AND archived_at IS NULL
    )
  ),
  timeout_milliseconds := 150000
) AS request_id;

-- Then wait ~30-90s and check results (replace <request_id> with the number above):
SELECT
  status_code,
  jsonb_array_length(COALESCE(content::jsonb -> 'results', '[]'::jsonb)) AS total,
  (SELECT COUNT(*) FROM jsonb_array_elements(content::jsonb -> 'results') r WHERE r->>'status' = 'ok') AS ok,
  (SELECT COUNT(*) FROM jsonb_array_elements(content::jsonb -> 'results') r WHERE r->>'status' = 'error') AS err
FROM net._http_response
WHERE id = <request_id>;`;

export default function DataOpsPage() {
  return (
    <div className="max-w-4xl space-y-8 py-6">
      <PageHeader
        eyebrow="Tools"
        title="Data ops"
        subtitle="Panels + SQL recipes for one-off data-operations. Per-attribute drift reconcilers live on Data health (/errors) — these are full-contact rebuilds and bulk data moves."
      />

      <section className="space-y-3">
        <h2 className="text-xs font-extrabold uppercase tracking-[0.14em] text-[#5a6a72]">
          UI panels
        </h2>
        <div className="grid grid-cols-1 gap-3">
          {TOOLS.map((tool) => (
            <ToolCard key={tool.href} tool={tool} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-extrabold uppercase tracking-[0.14em] text-[#5a6a72]">
          SQL recipes
        </h2>
        <p className="text-xs text-[#5a6a72] -mt-1">
          Paste into Supabase Studio → SQL editor. Used when a UI panel doesn&apos;t exist for a job, or when the Server Action wrapper is hitting framework limits.
        </p>

        <details className="rounded-xl border border-[#e5dfd8] bg-white p-4">
          <summary className="cursor-pointer font-extrabold text-[#11242e] text-base">
            Resync a course in Brevo
          </summary>
          <p className="text-sm text-[#11242e] mt-3 mb-3">
            Pushes every Brevo attribute (including the current <code className="font-mono text-xs">SW_COURSE_OPEN</code> from matrix.json) for every contact on the picked course slug. Run after closing a course in the YAML so existing contacts exit the N1-N3 spine cleanly. Idempotent — safe to re-run.
          </p>
          <pre className="bg-[#11242e] text-[#f5f2eb] text-[11px] p-4 rounded-md overflow-x-auto font-mono whitespace-pre-wrap">
{COURSE_RESYNC_SQL}
          </pre>
        </details>
      </section>
    </div>
  );
}

function ToolCard({ tool }: { tool: Tool }) {
  const style = STATUS_STYLE[tool.status];
  return (
    <Link
      href={tool.href}
      className="block rounded-xl border border-[#e5dfd8] bg-white p-4 hover:border-[#287271] hover:bg-[#f5f2eb] transition-colors"
    >
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <h3 className="text-base font-extrabold text-[#11242e] leading-tight">{tool.title}</h3>
        <span
          className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${style.pill} flex-shrink-0`}
        >
          {style.label}
        </span>
      </div>
      <p className="text-sm text-[#11242e]">{tool.description}</p>
      {tool.context && (
        <p className="text-xs text-[#5a6a72] mt-2 italic">{tool.context}</p>
      )}
      <p className="text-[10px] font-mono text-[#5a6a72] mt-3">{tool.href}</p>
    </Link>
  );
}
