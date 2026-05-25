"use client";

import { useState, useTransition, useEffect } from "react";
import {
  previewEmsSegmentAction,
  runEmsResyncAction,
  type SegmentPreviewResult,
  type RunResult,
} from "./actions";

export function EmsResyncPanel() {
  const [preview, setPreview] = useState<SegmentPreviewResult | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [previewPending, startPreview] = useTransition();
  const [runPending, startRun] = useTransition();
  const [confirmRun, setConfirmRun] = useState(false);

  // Auto-load preview on mount so Charlotte sees the count immediately.
  useEffect(() => {
    startPreview(async () => {
      try {
        setPreview(await previewEmsSegmentAction());
      } catch (err) {
        setPreview({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }, []);

  function run() {
    setResult(null);
    setConfirmRun(false);
    startRun(async () => {
      try {
        setResult(await runEmsResyncAction());
      } catch (err) {
        setResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  return (
    <div className="space-y-5">
      {previewPending && !preview && (
        <p className="text-xs text-[#5a6a72]">Counting candidates…</p>
      )}

      {preview && !preview.ok && (
        <ErrorBox title="Couldn't load segment" message={preview.error} />
      )}

      {preview && preview.ok && (
        <div className="rounded-xl border border-[#e5dfd8] bg-[#f5f2eb] p-4">
          <div className="flex items-baseline gap-3 flex-wrap">
            <div className="text-2xl font-extrabold text-[#11242e]">{preview.total}</div>
            <div className="text-sm text-[#5a6a72]">
              EMS · marketing-consented · not enrolled
            </div>
          </div>
          {preview.total > 0 && (
            <div className="mt-3 text-[11px] text-[#5a6a72]">
              First {Math.min(8, preview.total)} of {preview.total}:
              <ul className="mt-1 space-y-0.5">
                {preview.sample.map((s) => (
                  <li key={s.id} className="font-mono">
                    #{s.id} · {s.email ?? "(no email)"} · course=
                    {s.course_id ?? "—"} · fastracked={String(s.fastracked)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {preview && preview.ok && preview.total > 0 && !confirmRun && (
        <button
          type="button"
          onClick={() => setConfirmRun(true)}
          disabled={runPending}
          className="px-4 py-2 bg-[#11242e] text-white rounded-md text-sm font-semibold hover:bg-[#1a3540] disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
        >
          Resync {preview.total} contacts in Brevo
        </button>
      )}

      {confirmRun && (
        <div className="rounded-md border border-[#e9b3a4] bg-[#fffaf0] p-4 space-y-3">
          <p className="text-sm text-[#11242e]">
            <strong>Confirm.</strong> This rebuilds {preview && preview.ok ? preview.total : "every"} EMS contact card in Brevo using the corrected SW_FASTRACK_COMPLETED logic and establishes baseline rows in <code className="font-mono text-xs">crm.brevo_contact_state</code>. Takes ~30-90s. Safe to re-run.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={run}
              disabled={runPending}
              className="px-4 py-2 bg-[#b3412e] text-white rounded-md text-sm font-semibold hover:bg-[#8a2e1a] disabled:opacity-60 cursor-pointer"
            >
              {runPending ? "Resyncing…" : "Yes, resync now"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmRun(false)}
              disabled={runPending}
              className="px-4 py-2 text-sm font-semibold text-[#5a6a72] hover:text-[#11242e] cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {runPending && (
        <p className="text-xs text-[#5a6a72]">
          Resync in progress. EF throttles at 250ms/contact, expect ~{Math.ceil(((preview?.ok ? preview.total : 117) * 0.6))}s wall time. Don&apos;t close the tab.
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
              {result.ok_count} contacts now carry the corrected SW_FASTRACK_COMPLETED + have a baseline row in crm.brevo_contact_state.
              {result.error_count > 0 && " Check the per-id rows below for failure reasons; safe to re-run."}
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
