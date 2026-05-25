import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { CourseResyncPanel } from "./panel";

export const dynamic = "force-dynamic";

export default function BrevoResyncCoursePage() {
  return (
    <div className="max-w-3xl space-y-6 py-6">
      <PageHeader
        eyebrow={<Link href="/admin" className="hover:text-[#287271]">← Admin</Link>}
        title="Resync a course in Brevo"
        subtitle="Re-push every Brevo attribute (including SW_COURSE_OPEN read from current matrix.json) for every contact whose canonical course is the picked slug. Use after closing a course in the YAML so existing contacts exit the N1-N3 spine cleanly."
      />

      <div className="rounded-2xl border border-[#e5dfd8] bg-white p-5 space-y-4">
        <div>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.14em] text-[#5a6a72] mb-1">
            When to run this
          </h2>
          <ul className="text-sm text-[#11242e] space-y-1 list-disc list-inside">
            <li>Just set <code className="font-mono text-xs">accepting_applications: false</code> on a course YAML.</li>
            <li>Switchable site has rebuilt (matrix.json now carries the new flag).</li>
            <li>Click run — every contact on that course gets <code className="font-mono text-xs">SW_COURSE_OPEN = false</code> pushed.</li>
            <li>Wren&apos;s N1-N3 exit condition fires on the next 3:45 PM daily check.</li>
          </ul>
        </div>
        <div>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.14em] text-[#5a6a72] mb-1">
            What it touches
          </h2>
          <p className="text-sm text-[#11242e]">
            Fires <code className="font-mono text-xs">admin-brevo-resync</code> over every <code className="font-mono text-xs">leads.submissions</code> row with the picked <code className="font-mono text-xs">course_id</code>. Each upsert rebuilds the full Brevo attribute set — every SW_* attribute lands fresh, not just <code className="font-mono text-xs">SW_COURSE_OPEN</code>. Idempotent, safe to re-run.
          </p>
        </div>

        <CourseResyncPanel />
      </div>
    </div>
  );
}
