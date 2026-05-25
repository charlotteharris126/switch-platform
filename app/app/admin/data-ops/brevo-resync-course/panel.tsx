"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  listCoursesWithLearnersAction,
  listCourseIdsAction,
  runResyncBatchAction,
  type CourseOption,
  type ResyncOneResult,
} from "./actions";

const BATCH_SIZE = 30;

type RunSummary = {
  course_id: string;
  total_requested: number;
  ok_count: number;
  skipped_count: number;
  error_count: number;
  results: ResyncOneResult[];
};

export function CourseResyncPanel() {
  const [courses, setCourses] = useState<CourseOption[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [confirmRun, setConfirmRun] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [finalSummary, setFinalSummary] = useState<RunSummary | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const abortedRef = useRef(false);

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

  async function run() {
    setConfirmRun(false);
    setRunError(null);
    setFinalSummary(null);
    setRunning(true);
    abortedRef.current = false;

    try {
      const idsResult = await listCourseIdsAction(selected);
      if (!idsResult.ok) {
        setRunError(idsResult.error);
        setRunning(false);
        return;
      }
      const ids = idsResult.ids;
      setProgress({ done: 0, total: ids.length });

      const allResults: ResyncOneResult[] = [];
      for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
        if (abortedRef.current) break;
        const batch = ids.slice(offset, offset + BATCH_SIZE);
        const r = await runResyncBatchAction(batch);
        if (!r.ok) {
          setRunError(`Batch starting at ${offset} failed: ${r.error}. ${allResults.length} contacts resynced before failure — safe to re-run (idempotent).`);
          break;
        }
        allResults.push(...r.results);
        setProgress({ done: Math.min(offset + BATCH_SIZE, ids.length), total: ids.length });
      }

      setFinalSummary({
        course_id: idsResult.course_id,
        total_requested: ids.length,
        ok_count: allResults.filter((r) => r.status === "ok").length,
        skipped_count: allResults.filter((r) => r.status === "skipped").length,
        error_count: allResults.filter((r) => r.status === "error").length,
        results: allResults,
      });
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  function stop() {
    abortedRef.current = true;
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
              setFinalSummary(null);
              setRunError(null);
              setConfirmRun(false);
            }}
            disabled={running || !courses}
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

        {selected && !confirmRun && !running && !finalSummary && (
          <button
            type="button"
            onClick={() => setConfirmRun(true)}
            className="px-4 py-2 bg-[#11242e] text-white rounded-md text-sm font-semibold hover:bg-[#1a3540] cursor-pointer"
          >
            Resync {selectedOption?.learner_count ?? "all"} contacts
          </button>
        )}
      </div>

      {confirmRun && selectedOption && (
        <div className="rounded-md border border-[#e9b3a4] bg-[#fffaf0] p-4 space-y-3">
          <p className="text-sm text-[#11242e]">
            <strong>Confirm.</strong> Re-pushes every Brevo attribute (including the current <code className="font-mono text-xs">SW_COURSE_OPEN</code> from matrix.json) for the {selectedOption.learner_count} contact{selectedOption.learner_count === 1 ? "" : "s"} on{" "}
            <code className="font-mono text-xs">{selectedOption.course_id}</code>. Runs in batches of {BATCH_SIZE} (~{Math.ceil(BATCH_SIZE * 0.7)}s per batch). Total ~{Math.ceil(selectedOption.learner_count * 0.7)}s.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={run}
              className="px-4 py-2 bg-[#b3412e] text-white rounded-md text-sm font-semibold hover:bg-[#8a2e1a] cursor-pointer"
            >
              Yes, resync now
            </button>
            <button
              type="button"
              onClick={() => setConfirmRun(false)}
              className="px-4 py-2 text-sm font-semibold text-[#5a6a72] hover:text-[#11242e] cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {running && progress && (
        <div className="rounded-md border border-[#bcdfd8] bg-[#dcefea] p-4 space-y-3">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <p className="text-sm text-[#1f5f5e] font-semibold">
              Resyncing… {progress.done} / {progress.total}
            </p>
            <button
              type="button"
              onClick={stop}
              className="px-3 py-1 text-xs font-semibold text-[#8a2e1a] hover:underline cursor-pointer"
            >
              Stop after current batch
            </button>
          </div>
          <div className="h-2 bg-white rounded-full overflow-hidden border border-[#bcdfd8]">
            <div
              className="h-full bg-[#287271] transition-[width] duration-300"
              style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
            />
          </div>
          <p className="text-[11px] text-[#1f5f5e]">
            Don&apos;t close the tab. Batches of {BATCH_SIZE} sequentially; if a batch fails, partial results are kept.
          </p>
        </div>
      )}

      {runError && (
        <ErrorBox title="Resync stopped" message={runError} />
      )}

      {finalSummary && (
        <div className="space-y-3">
          <div
            className={`rounded-md border p-4 ${
              finalSummary.error_count === 0
                ? "bg-[#dcefea] border-[#bcdfd8] text-[#1f5f5e]"
                : "bg-[#fcefd6] border-[#f0d99c] text-[#92651c]"
            }`}
          >
            <p className="font-semibold text-sm">
              {finalSummary.ok_count} resynced · {finalSummary.skipped_count} skipped · {finalSummary.error_count} errors
            </p>
            <p className="text-xs mt-1">
              <code className="font-mono">{finalSummary.course_id}</code> — every contact now carries the current <code className="font-mono">SW_COURSE_OPEN</code> from matrix.json.
              {finalSummary.error_count > 0 && " Check the per-id rows below; safe to re-run."}
            </p>
          </div>

          {finalSummary.results.length > 0 && (
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
                  {finalSummary.results.map((r) => (
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
