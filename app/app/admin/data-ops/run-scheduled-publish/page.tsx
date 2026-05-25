// /admin/data-ops/run-scheduled-publish — manual trigger for the
// editorial.auto_publish_scheduled_posts cron function. Lets Charlotte
// test scheduled publishing without waiting for the 15-min tick.

"use client";

import { useState, useTransition } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { triggerAutoPublishAction } from "../../blog/actions";

type State =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; flipped_count: number; flipped_slugs: string[] }
  | { phase: "error"; error: string };

export default function RunScheduledPublishPage() {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<State>({ phase: "idle" });

  function runNow() {
    setState({ phase: "running" });
    startTransition(async () => {
      try {
        const r = await triggerAutoPublishAction();
        if (!r.ok) setState({ phase: "error", error: r.error });
        else setState({ phase: "done", flipped_count: r.data.flipped_count, flipped_slugs: r.data.flipped_slugs });
      } catch (err) {
        setState({ phase: "error", error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  return (
    <div className="max-w-2xl space-y-6 py-6">
      <PageHeader
        eyebrow="Tools"
        title="Run scheduled-publish cron now"
        subtitle="Manually invokes editorial.auto_publish_scheduled_posts(). Flips status=scheduled → published for any post whose publish_at (or fallback publish_date 06:00 UTC) has passed. Use to test scheduling without waiting for the 15-min tick."
      />

      <section className="bg-white rounded-xl border border-[#e5dfd8] p-5 space-y-4">
        <p className="text-sm text-[#11242e]">
          What this does:
        </p>
        <ol className="list-decimal pl-5 text-sm text-[#11242e] space-y-1.5">
          <li>Scans editorial.posts for status = scheduled where publish_at &lt;= NOW().</li>
          <li>Flips matching rows to status = published, sets last_modified.</li>
          <li>Fires the Netlify build hook with reason &quot;auto-publish: &lt;slugs&gt;&quot; if anything flipped.</li>
        </ol>

        <p className="text-[12px] text-[#5a6a72] italic">
          To test scheduling: edit a draft, set status = scheduled, set publish date + time to a few minutes from now, save. Wait ~15 min (the cron tick), OR click below to flip it immediately.
        </p>

        <Button onClick={runNow} disabled={pending} className="bg-[#287271] hover:bg-[#246564] text-white">
          {pending ? "Running..." : "Run auto-publish now"}
        </Button>

        {state.phase === "done" && (
          <div className={`rounded-md border px-3 py-2 text-sm ${
            state.flipped_count > 0
              ? "border-[#bcdfd8] bg-[#dcefea] text-[#1f5f5e]"
              : "border-[#d4ccc0] bg-[#f5f2eb] text-[#5a6a72]"
          }`}>
            {state.flipped_count === 0
              ? "Nothing to flip. No scheduled posts have a publish_at moment in the past."
              : <>Flipped {state.flipped_count} post{state.flipped_count === 1 ? "" : "s"}: {state.flipped_slugs.join(", ")}. Netlify build hook fired.</>}
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
