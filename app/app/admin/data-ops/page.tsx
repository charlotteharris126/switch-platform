// /admin/data-ops — index of one-shot + ongoing data-operation panels.
//
// History: this page used to redirect to /errors back when "data-ops" meant
// the migrated one-shot panels from the 024 era. As the platform's grown,
// new panels have landed here that aren't tied to error-fixing (port-blog-yaml,
// brevo-resync-course etc.). The redirect was hiding them — the URL now
// renders a proper directory so Charlotte can discover what's available
// without remembering specific subroute paths.

import Link from "next/link";
import { PageHeader } from "@/components/page-header";

type ToolStatus = "ongoing" | "one_shot" | "throwaway";
type Tool = {
  href: string;
  title: string;
  description: string;
  status: ToolStatus;
  context?: string;
};

const TOOLS: Tool[] = [
  // ── Ongoing — keep ──────────────────────────────────────────────────────
  {
    href: "/admin/data-ops/brevo-resync-course",
    title: "Resync a course in Brevo",
    description:
      "Re-push every Brevo attribute (including SW_COURSE_OPEN read from current matrix.json) for every contact whose canonical course is the picked slug.",
    status: "ongoing",
    context:
      "Run after closing or reopening a course in the YAML — drives Wren's N1-N3 course-state exit. Course dropdown lists every slug with a learner count.",
  },

  // ── One-shot — retire after first use ───────────────────────────────────
  {
    href: "/admin/data-ops/brevo-resync-ems-segment",
    title: "Resync EMS marketing-consented segment in Brevo",
    description:
      "Fires admin-brevo-resync over the ~117 EMS marketing-consented non-enrolled contacts to backfill SW_FASTRACK_COMPLETED (per-canonical) and seed crm.brevo_contact_state baseline rows.",
    status: "one_shot",
    context:
      "Pre-broadcast gate for the EMS new-course broadcast (Wren push 2026-05-25). Idempotent — safe to re-run while debugging. Retire once broadcast has shipped + spot-checks clean.",
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
  one_shot: { pill: "bg-[#fcefd6] text-[#92651c] border-[#f0d99c]", label: "One-shot" },
  throwaway: { pill: "bg-[#eee9e0] text-[#5a6a72] border-[#d4ccc0]", label: "Throwaway" },
};

export default function DataOpsPage() {
  const ongoing = TOOLS.filter((t) => t.status === "ongoing");
  const oneShot = TOOLS.filter((t) => t.status !== "ongoing");

  return (
    <div className="max-w-4xl space-y-8 py-6">
      <PageHeader
        eyebrow="Tools"
        title="Data ops"
        subtitle="One-shot and ongoing data-operation panels. Per-attribute drift reconcilers live on Data health (/errors) — these are full-contact rebuilds and bulk data moves."
      />

      <section className="space-y-3">
        <h2 className="text-xs font-extrabold uppercase tracking-[0.14em] text-[#5a6a72]">
          Ongoing
        </h2>
        <p className="text-xs text-[#5a6a72] -mt-1">
          Keep these. Reach for them whenever the trigger condition applies.
        </p>
        <div className="grid grid-cols-1 gap-3">
          {ongoing.map((tool) => (
            <ToolCard key={tool.href} tool={tool} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-extrabold uppercase tracking-[0.14em] text-[#5a6a72]">
          One-shot / throwaway
        </h2>
        <p className="text-xs text-[#5a6a72] -mt-1">
          Built for a specific job. Safe to delete the route once the job is done — context line names the trigger.
        </p>
        <div className="grid grid-cols-1 gap-3">
          {oneShot.map((tool) => (
            <ToolCard key={tool.href} tool={tool} />
          ))}
        </div>
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
