"use client";

import { useState, useTransition } from "react";
import {
  type BackfillResult,
  type BackfillSummary,
  runBackfillAction,
} from "./actions";

export function Run024Panel() {
  const [pending, startTransition] = useTransition();
  const [pendingMode, setPendingMode] = useState<"dry_run" | "apply" | null>(null);
  const [result, setResult] = useState<BackfillResult | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);

  function fire(apply: boolean) {
    setResult(null);
    setPendingMode(apply ? "apply" : "dry_run");
    startTransition(async () => {
      try {
        const r = await runBackfillAction({ apply });
        setResult(r);
      } catch (err) {
        // Catches Server Action throws (e.g. fetch timeouts on Netlify's
        // ~26s function cap when the Edge Function is still running). The
        // Edge Function itself is idempotent + tolerant of partial runs,
        // so the operator can re-run dry-run / apply to mop up.
        setResult({
          ok: false,
          error:
            (err instanceof Error ? err.message : String(err)) +
            " — the underlying job may still be running. Re-run dry-run in a minute to see current state.",
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
              This will write to Brevo. Confirm?
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

      {pending && (
        <div className="text-xs text-slate-500">
          The function may take up to 90s. Don&apos;t close the tab.
        </div>
      )}

      {result && !result.ok && (
        <div className="bg-rose-50 border border-rose-200 rounded-md p-4 text-sm text-rose-900">
          <p className="font-semibold mb-1">Failed</p>
          <p>{result.error}</p>
        </div>
      )}

      {result && result.ok && <SummaryView summary={result} />}
    </div>
  );
}

function SummaryView({ summary }: { summary: BackfillSummary }) {
  const tone = summary.errors > 0 ? "amber" : "emerald";
  const palette = tone === "emerald"
    ? "bg-emerald-50 border-emerald-200 text-emerald-900"
    : "bg-amber-50 border-amber-200 text-amber-900";

  return (
    <div className="space-y-4">
      <div className={`border rounded-md p-4 text-sm ${palette}`}>
        <p className="font-semibold mb-2">
          {summary.mode === "dry_run" ? "Dry-run complete" : "Apply complete"}
        </p>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <dt className="text-slate-600">Audience size</dt>
          <dd className="font-mono tabular-nums">{summary.audience_size}</dd>
          <dt className="text-slate-600">Processed</dt>
          <dd className="font-mono tabular-nums">{summary.processed}</dd>
          <dt className="text-slate-600">
            {summary.mode === "dry_run" ? "Would mutate" : "Mutated"}
          </dt>
          <dd className="font-mono tabular-nums font-semibold">{summary.mutated}</dd>
          <dt className="text-slate-600">Skipped (not in audience)</dt>
          <dd className="font-mono tabular-nums">{summary.skipped_no_submission}</dd>
          <dt className="text-slate-600">Skipped (already matching)</dt>
          <dd className="font-mono tabular-nums">{summary.skipped_already_matching}</dd>
          <dt className="text-slate-600">Errors</dt>
          <dd className="font-mono tabular-nums">{summary.errors}</dd>
        </dl>
      </div>

      {summary.error_messages.length > 0 && (
        <div className="bg-rose-50 border border-rose-200 rounded-md p-4 text-xs">
          <p className="font-semibold text-rose-900 mb-1">Error messages</p>
          <ul className="space-y-1 text-rose-800">
            {summary.error_messages.map((m, i) => (
              <li key={i} className="font-mono break-all">{m}</li>
            ))}
          </ul>
        </div>
      )}

      {summary.spot_checks.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-md p-4">
          <p className="text-sm font-semibold text-slate-900 mb-3">
            Spot checks {summary.mode === "dry_run" ? "(before / desired)" : "(before / after)"}
          </p>
          <div className="space-y-3 text-xs">
            {summary.spot_checks.map((sc) => (
              <div
                key={sc.email}
                className="border border-slate-200 rounded p-3 bg-slate-50 space-y-2"
              >
                <p className="font-mono text-slate-900 break-all font-semibold">{sc.email}</p>
                <SpotCheckRow
                  label="SW_REFERRAL_URL"
                  before={sc.before_referral}
                  after={summary.mode === "dry_run" ? sc.desired_referral : (sc.after_referral ?? "")}
                />
                <SpotCheckRow
                  label="SW_FASTRACK_URL"
                  before={sc.before_fastrack}
                  after={summary.mode === "dry_run" ? sc.desired_fastrack : (sc.after_fastrack ?? "")}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SpotCheckRow({
  label,
  before,
  after,
}: {
  label: string;
  before: string;
  after: string;
}) {
  const same = before === after;
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">{label}</p>
      <div className="grid grid-cols-[60px_1fr] gap-2 items-baseline">
        <span className="text-[10px] uppercase text-slate-500 font-semibold">Before</span>
        <span className="font-mono text-slate-700 break-all">
          {before === "" ? <em className="text-slate-400 not-italic">(empty)</em> : before}
        </span>
      </div>
      <div className="grid grid-cols-[60px_1fr] gap-2 items-baseline">
        <span className="text-[10px] uppercase text-slate-500 font-semibold">After</span>
        <span
          className={`font-mono break-all ${same ? "text-slate-500" : "text-emerald-800 font-semibold"}`}
        >
          {after === "" ? <em className="text-slate-400 not-italic">(empty)</em> : after}
          {same && <span className="text-[10px] text-slate-500 ml-2">(no change)</span>}
        </span>
      </div>
    </div>
  );
}
