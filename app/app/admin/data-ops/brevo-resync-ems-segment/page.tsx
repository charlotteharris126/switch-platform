import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmsResyncPanel } from "./panel";

export const dynamic = "force-dynamic";

export default function BrevoResyncEmsSegmentPage() {
  return (
    <div className="max-w-3xl space-y-6 py-6">
      <PageHeader
        eyebrow={<Link href="/admin" className="hover:text-[#287271]">← Admin</Link>}
        title="Resync EMS segment in Brevo"
        subtitle="Pre-broadcast backfill. Rebuilds every EMS marketing-consented non-enrolled contact in Brevo using the 2026-05-25 SW_FASTRACK_COMPLETED fix + establishes baseline rows in crm.brevo_contact_state so future course flips trigger SW_PENDING_RESTART."
      />

      <div className="rounded-2xl border border-[#e5dfd8] bg-white p-5 space-y-4">
        <div>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.14em] text-[#5a6a72] mb-1">
            What this does
          </h2>
          <ul className="text-sm text-[#11242e] space-y-1 list-disc list-inside">
            <li>Finds every <code className="font-mono text-xs">leads.submissions</code> row with <code className="font-mono text-xs">primary_routed_to = 'enterprise-made-simple'</code>, <code className="font-mono text-xs">marketing_opt_in = true</code>, and latest enrolment status NOT in (<em>enrolled</em>, <em>presumed_enrolled</em>).</li>
            <li>Fires <code className="font-mono text-xs">admin-brevo-resync</code> over the full ID list. The EF throttles at 250ms/contact to stay under Brevo&apos;s rate limit.</li>
            <li>Each upsert rebuilds every Brevo attribute including the corrected <code className="font-mono text-xs">SW_FASTRACK_COMPLETED</code> AND writes a baseline row into <code className="font-mono text-xs">crm.brevo_contact_state</code> (so the next course flip per contact triggers <code className="font-mono text-xs">SW_PENDING_RESTART</code>).</li>
            <li>Idempotent — safe to re-run if anything fails partway.</li>
          </ul>
        </div>

        <EmsResyncPanel />
      </div>

      <p className="text-xs text-[#5a6a72]">
        After this runs: Wren spot-checks 3 contacts in Brevo per <code className="font-mono">switchable/email/CLAUDE.md</code> pre-broadcast gate, then the EMS new-course broadcast can ship.
      </p>
    </div>
  );
}
