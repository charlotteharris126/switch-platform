// /admin/data-ops/backfill-waitlist-identity — one-click backfill of waitlist
// contacts' name/location/qualification from their parent submission, then
// re-sync to Brevo. Mirrors run-scheduled-publish (fast DB-function call via a
// Server Action — the reliable one-click pattern, not a bulk-resync panel).
// See migration 0208 + platform/docs/waitlist-capture-fix.md.

"use client";

import { useState, useTransition } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { backfillWaitlistIdentityAction } from "../actions";

type State =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; filled_count: number; affected_ids: number[] }
  | { phase: "error"; error: string };

export default function BackfillWaitlistIdentityPage() {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<State>({ phase: "idle" });

  function runNow() {
    setState({ phase: "running" });
    startTransition(async () => {
      try {
        const r = await backfillWaitlistIdentityAction();
        if (!r.ok) setState({ phase: "error", error: r.error });
        else setState({ phase: "done", filled_count: r.data.filled_count, affected_ids: r.data.affected_ids });
      } catch (err) {
        setState({ phase: "error", error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  return (
    <div className="max-w-2xl space-y-6 py-6">
      <PageHeader
        eyebrow="Tools"
        title="Backfill waitlist identity from parent"
        subtitle="Copies name, location (postcode/region/LA) and qualification onto opted-in /waitlist/ contacts from the earlier form submission they came through, then re-syncs them to Brevo. Fixes the 'Hi ,' blank-name problem. Idempotent — safe to re-run."
      />

      <section className="bg-white rounded-xl border border-[#e5dfd8] p-5 space-y-4">
        <p className="text-sm text-[#11242e]">What this does:</p>
        <ol className="list-decimal pl-5 text-sm text-[#11242e] space-y-1.5">
          <li>Finds opted-in waitlist contacts whose row is missing name/location/qualification.</li>
          <li>Fills each missing field from their linked parent submission (only where the parent has it).</li>
          <li>Re-syncs every touched contact to Brevo so FIRSTNAME and the SW_* attributes stop rendering blank.</li>
        </ol>

        <p className="text-[12px] text-[#5a6a72] italic">
          Course interest is not recovered here (it isn&apos;t in the data for these contacts). They become targetable by name and location; new waitlist signups capture course via the going-forward form fix.
        </p>

        <Button onClick={runNow} disabled={pending} className="bg-[#287271] hover:bg-[#246564] text-white">
          {pending ? "Running..." : "Run backfill now"}
        </Button>

        {state.phase === "done" && (
          <div className={`rounded-md border px-3 py-2 text-sm ${
            state.filled_count > 0
              ? "border-[#bcdfd8] bg-[#dcefea] text-[#1f5f5e]"
              : "border-[#d4ccc0] bg-[#f5f2eb] text-[#5a6a72]"
          }`}>
            {state.filled_count === 0
              ? "Nothing to fill. Every eligible waitlist contact already has its identity backfilled."
              : <>Backfilled {state.filled_count} contact{state.filled_count === 1 ? "" : "s"} (ids: {state.affected_ids.join(", ")}) and re-synced them to Brevo.</>}
          </div>
        )}

        {state.phase === "error" && (
          <div className="rounded-md border border-[#e9b3a4] bg-[#f7d8d0] text-[#8a2e1a] px-3 py-2 text-sm">
            {state.error}
          </div>
        )}
      </section>
    </div>
  );
}
