"use client";

import { useEffect, useState, useTransition } from "react";
import {
  listCoursesWithLearnersAction,
  runCourseResyncAction,
  type CourseOption,
  type RunResult,
} from "./actions";

export function CourseResyncPanel() {
  const [courses, setCourses] = useState<CourseOption[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [confirmRun, setConfirmRun] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await listCoursesWithLearnersAction();
      if (cancelled) return;
      if (r.ok) setCourses(r.courses);
      else setLoadErr(r.error);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedOption = courses?.find((c) => c.course_id === selected) ?? null;

  function run() {
    setResult(null);
    setConfirmRun(false);
    startTransition(async () => {
      try {
        setResult(await runCourseResyncAction(selected));
      } catch (err) {
        setResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  return (
    <div className="space-y-5">
      {loadErr && (
        <ErrorBox title="Couldn't load course list" message={loadErr} />
      )}

      <div className="flex gap-3 items-end flex-wrap">
        <div className="flex-1 min-w-[280px]">
          <label className="block text-[11px] font-bold uppercase tracking-[0.14em] text-[#5a6a72] mb-1.5">
            Course slug
          </label>
          <select
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setResult(null);
              setConfirmRun(false);
            }}
            disabled={pending || !courses}
            className="w-full border border-[#d4ccc0] rounded-md px-3 py-2 text-sm bg-white"
          >
            <option value="">
              {courses ? `— pick a course (${courses.length} with learners)` : "Loading…"}
            </option>
            {(courses ?? []).map((c) => (
              <option key={c.course_id} value={c.course_id}>
                {c.course_id} · {c.learner_count} learner{c.learner_count === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </div>

        {selected && !confirmRun && (
          <button
            type="button"
            onClick={() => setConfirmRun(true)}
            disabled={pending}
            className="px-4 py-2 bg-[#11242e] text-white rounded-md text-sm font-semibold hover:bg-[#1a3540] disabled:opacity-60 cursor-pointer"
          >
            Resync {selectedOption?.learner_count ?? "all"} contacts
          </button>
        )}
      </div>

      {confirmRun && selectedOption && (
        <div className="rounded-md border border-[#e9b3a4] bg-[#fffaf0] p-4 space-y-3">
          <p className="text-sm text-[#11242e]">
            <strong>Confirm.</strong> This re-pushes every Brevo attribute (including the new <code className="font-mono text-xs">SW_COURSE_OPEN</code> from matrix.json) for the {selectedOption.learner_count} contact{selectedOption.learner_count === 1 ? "" : "s"} on{" "}
            <code className="font-mono text-xs">{selectedOption.course_id}</code>. EF throttles at 250ms/contact ≈ {Math.ceil(selectedOption.learner_count * 0.6)}s wall time.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={run}
              disabled={pending}
              className="px-4 py-2 bg-[#b3412e] text-white rounded-md text-sm font-semibold hover:bg-[#8a2e1a] disabled:opacity-60 cursor-pointer"
            >
              {pending ? "Resyncing…" : "Yes, resync now"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmRun(false)}
              disabled={pending}
              className="px-4 py-2 text-sm font-semibold text-[#5a6a72] hover:text-[#11242e] cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {pending && (
        <p className="text-xs text-[#5a6a72]">
          Resync in progress. Don&apos;t close the tab.
        </p>
      )}

      {result && !result.ok && (
        <ErrorBox title="Resync failed" message={result.error} />
      )}

      {result && result.ok && (
        <div className="space-y-3">
          <div
            className={`rounded-md border p-4 ${
              result.error_count === 0
                ? "bg-[#dcefea] border-[#bcdfd8] text-[#1f5f5e]"
                : "bg-[#fcefd6] border-[#f0d99c] text-[#92651c]"
            }`}
          >
            <p className="font-semibold text-sm">
              {result.ok_count} resynced · {result.skipped_count} skipped · {result.error_count} errors
            </p>
            <p className="text-xs mt-1">
              <code className="font-mono">{result.course_id}</code> — every contact now carries the current <code className="font-mono">SW_COURSE_OPEN</code> value from matrix.json.
              {result.error_count > 0 && " Check the per-id rows below; safe to re-run."}
            </p>
          </div>

          {result.results.length > 0 && (
            <div className="bg-white border border-[#e5dfd8] rounded-md max-h-80 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-[#f5f2eb] text-[#5a6a72] uppercase tracking-wide sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left font-bold">ID</th>
                    <th className="px-3 py-2 text-left font-bold">Status</th>
                    <th className="px-3 py-2 text-left font-bold">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#f0ece3]">
                  {result.results.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-1.5 font-mono">{r.id}</td>
                      <td className={`px-3 py-1.5 font-semibold ${
                        r.status === "ok" ? "text-[#1f5f5e]" : r.status === "skipped" ? "text-[#92651c]" : "text-[#8a2e1a]"
                      }`}>
                        {r.status}
                      </td>
                      <td className="px-3 py-1.5 text-[#5a6a72]">{r.reason ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ErrorBox({ title, message }: { title: string; message: string }) {
  return (
    <div className="bg-[#f7d8d0] border border-[#e9b3a4] rounded-md p-4 text-sm text-[#8a2e1a]">
      <p className="font-semibold mb-1">{title}</p>
      <p className="font-mono text-xs break-all">{message}</p>
    </div>
  );
}
