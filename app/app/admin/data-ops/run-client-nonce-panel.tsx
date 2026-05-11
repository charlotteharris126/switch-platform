"use client";

import { useState, useTransition } from "react";
import {
  type NonceBackfillResult,
  type NonceBackfillSummary,
  runNonceBackfillAction,
} from "./actions";

export function RunClientNoncePanel() {
  const [pending, startTransition] = useTransition();
  const [pendingMode, setPendingMode] = useState<"dry_run" | "apply" | null>(null);
  const [result, setResult] = useState<NonceBackfillResult | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);

  function fire(apply: boolean) {
    setResult(null);
    setPendingMode(apply ? "apply" : "dry_run");
    startTransition(async () => {
      try {
        const r = await runNonceBackfillAction({ apply });
        setResult(r);
      } catch (err) {
        setResult({
          ok: false,
          error:
            (err instanceof Error ? err.message : String(err)) +
            " — the underlying job may still be running. Re-run dry-run to see current state.",
        });
      } finally {
        setPendingMode(null);
        if (apply) setConfirmApply(false);
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => fire(false)}
          disabled={pending}
          className="px-4 py-2 bg-white text-slate-900 border border-slate-300 rounded-md text-sm font-semibold hover:bg-slate-50 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
        >
          {pending && pendingMode === "dry_run" ? "Running dry-run..." : "Run dry-run"}
        </button>
        {!confirmApply ? (
          <button
            type="button"
            onClick={() => setConfirmApply(true)}
            disabled={pending}
            className="px-4 py-2 bg-rose-700 text-white rounded-md text-sm font-semibold hover:bg-rose-800 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
          >
            Apply (live writes)
          </button>
        ) : (
          <div className="flex items-center gap-2 bg-rose-50 border border-rose-200 rounded-md px-3 py-1.5">
            <span className="text-xs text-rose-900 font-semibold">
              This will UPDATE leads.submissions. Confirm?
            </span>
            <button
              type="button"
              onClick={() => fire(true)}
              disabled={pending}
              className="px-3 py-1 bg-rose-700 text-white rounded-md text-xs font-semibold hover:bg-rose-800 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              {pending && pendingMode === "apply" ? "Writing..." : "Yes, apply"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmApply(false)}
              disabled={pending}
              className="px-3 py-1 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer disabled:cursor-not-allowed"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {result && !result.ok && (
        <div className="bg-rose-50 border border-rose-200 rounded-md p-4 text-sm text-rose-900">
          <p className="font-semibold mb-1">Failed</p>
          <p>{result.error}</p>
        </div>
      )}

      {result && result.ok && <NonceSummaryView summary={result} />}
    </div>
  );
}

function NonceSummaryView({ summary }: { summary: NonceBackfillSummary }) {
  return (
    <div className="space-y-4">
      <div className="border rounded-md p-4 text-sm bg-emerald-50 border-emerald-200 text-emerald-900">
        <p className="font-semibold mb-2">
          {summary.mode === "dry_run" ? "Dry-run complete" : "Apply complete"}
        </p>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <dt className="text-slate-600">In audience</dt>
          <dd className="font-mono tabular-nums">{summary.audience_size}</dd>
          <dt className="text-slate-600">
            {summary.mode === "dry_run" ? "Would update" : "Updated"}
          </dt>
          <dd className="font-mono tabular-nums font-semibold">
            {summary.mode === "dry_run" ? summary.audience_size : summary.mutated}
          </dd>
        </dl>
      </div>

      {summary.spot_checks.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-md p-4">
          <p className="text-sm font-semibold text-slate-900 mb-3">
            Spot checks {summary.mode === "dry_run" ? "(sample of would-update)" : "(sample of updated)"}
          </p>
          <div className="space-y-3 text-xs">
            {summary.spot_checks.map((sc) => (
              <div
                key={sc.id}
                className="border border-slate-200 rounded p-3 bg-slate-50 space-y-1"
              >
                <p className="font-semibold text-slate-900">
                  #{sc.id} · {sc.full_name}
                  {sc.email && <span className="text-slate-500 font-normal"> · {sc.email}</span>}
                </p>
                <p className="text-slate-600">
                  {sc.funding_category} · submitted{" "}
                  {new Date(sc.submitted_at).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </p>
                {summary.mode === "apply" && (
                  <p className="font-mono text-[11px] text-slate-700 break-all">
                    {sc.fastrack_url}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {summary.mode === "apply" && summary.mutated > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-xs text-amber-900">
          <p className="font-semibold mb-1">Heads up</p>
          <p>
            New nonces are now on the DB. To propagate them to existing Brevo
            contacts&apos; SW_FASTRACK_URL attribute (for future {`{{ SW_FASTRACK_URL }}`} broadcasts),
            re-run the 024 backfill above.
          </p>
        </div>
      )}
    </div>
  );
}
