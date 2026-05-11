"use client";

import { useState, useTransition } from "react";
import {
  type RepublishResult,
  type RepublishSummary,
  republishSheetAction,
} from "./republish-sheet-action";

export function RepublishSheetPanel({ providerId }: { providerId: string }) {
  const [pending, startTransition] = useTransition();
  const [pendingMode, setPendingMode] = useState<"dry_run" | "apply" | null>(null);
  const [result, setResult] = useState<RepublishResult | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);

  function fire(apply: boolean) {
    setResult(null);
    setPendingMode(apply ? "apply" : "dry_run");
    startTransition(async () => {
      try {
        const r = await republishSheetAction({ provider_id: providerId, apply });
        setResult(r);
      } catch (err) {
        setResult({
          ok: false,
          error:
            (err instanceof Error ? err.message : String(err)) +
            " — the underlying job may still be running. Wait a minute, then dry-run again.",
        });
      } finally {
        setPendingMode(null);
        if (apply) setConfirmApply(false);
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => fire(false)}
          disabled={pending}
          className="px-3 py-1.5 bg-white text-[#11242e] border border-[#dde3e6] rounded text-xs font-semibold hover:bg-[#f4f1ed] disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
        >
          {pending && pendingMode === "dry_run" ? "Counting..." : "Dry-run"}
        </button>
        {!confirmApply ? (
          <button
            type="button"
            onClick={() => setConfirmApply(true)}
            disabled={pending}
            className="px-3 py-1.5 bg-[#b3412e] text-white rounded text-xs font-semibold hover:bg-[#902f1e] disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
          >
            Republish sheet from DB
          </button>
        ) : (
          <div className="flex items-center gap-2 bg-rose-50 border border-rose-200 rounded px-2 py-1">
            <span className="text-[11px] text-rose-900 font-semibold">
              Will overwrite every routed lead&apos;s status + fastrack columns. Confirm?
            </span>
            <button
              type="button"
              onClick={() => fire(true)}
              disabled={pending}
              className="px-2.5 py-1 bg-[#b3412e] text-white rounded text-[11px] font-semibold hover:bg-[#902f1e] disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              {pending && pendingMode === "apply" ? "Writing..." : "Yes, republish"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmApply(false)}
              disabled={pending}
              className="px-2 py-1 text-[11px] font-semibold text-[#5a6a72] hover:text-[#11242e] cursor-pointer disabled:cursor-not-allowed"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {result && !result.ok && (
        <div className="bg-rose-50 border border-rose-200 rounded p-3 text-xs text-rose-900">
          <p className="font-semibold mb-1">Failed</p>
          <p>{result.error}</p>
        </div>
      )}

      {result && result.ok && <RepublishSummaryView summary={result} />}
    </div>
  );
}

function RepublishSummaryView({ summary }: { summary: RepublishSummary }) {
  return (
    <div className="space-y-3">
      <div className="bg-emerald-50 border border-emerald-200 rounded p-3 text-xs text-emerald-900">
        <p className="font-semibold mb-1">
          {summary.mode === "dry_run"
            ? `Dry-run: ${summary.leads_total} routed leads would be republished`
            : `Republish complete`}
        </p>
        {summary.mode === "apply" && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            <dt className="text-[#5a6a72]">Total routed</dt>
            <dd className="font-mono tabular-nums">{summary.leads_total}</dd>
            <dt className="text-[#5a6a72]">Written</dt>
            <dd className="font-mono tabular-nums font-semibold">{summary.leads_written}</dd>
            <dt className="text-[#5a6a72]">Skipped (not in sheet)</dt>
            <dd className="font-mono tabular-nums">{summary.leads_skipped_no_appender_ack}</dd>
            <dt className="text-[#5a6a72]">Errors</dt>
            <dd className="font-mono tabular-nums">{summary.errors}</dd>
          </dl>
        )}
      </div>

      {summary.error_messages.length > 0 && (
        <div className="bg-rose-50 border border-rose-200 rounded p-3 text-xs">
          <p className="font-semibold text-rose-900 mb-1">Error rows</p>
          <ul className="space-y-0.5 text-rose-800 max-h-32 overflow-auto">
            {summary.error_messages.slice(0, 50).map((m, i) => (
              <li key={i} className="font-mono">{m}</li>
            ))}
          </ul>
        </div>
      )}

      {summary.spot_checks.length > 0 && (
        <div className="bg-white border border-[#dde3e6] rounded p-3 text-xs">
          <p className="font-semibold text-[#11242e] mb-2">Spot checks (DB state)</p>
          <ul className="space-y-1">
            {summary.spot_checks.map((sc) => (
              <li key={sc.submission_id} className="font-mono">
                #{sc.submission_id} · {sc.status_db}
                {sc.lost_reason_db ? ` (${sc.lost_reason_db})` : ""}
                {sc.fastracked ? " · fastracked" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
