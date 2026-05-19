"use client";

// Netlify ↔ DB reconcile panel. Mirrors the Sheet ↔ DB panel shape:
//   1. "Check drift" — calls netlify-leads-reconcile (apply:false). Returns
//      a list of submissions present in Netlify's form store but missing
//      from leads.submissions over the last 24h.
//   2. "Back-fill N" — calls the same function with apply:true to insert
//      the missing rows via the shared ingest pipeline. Dead-letter rows
//      get written with source='reconcile_backfill' for audit.
//
// Auto-fire safety net:
//   The same Edge Function already runs hourly on cron (data-ops/004).
//   This panel exists for two cases: (a) operator wants to see drift NOW
//   without waiting for the next hourly run; (b) the cron itself is
//   suspected of failing.

import { useState, useTransition } from "react";
import {
  type NetlifyReconcileResult,
  netlifyReconcileAction,
} from "./reconcile-actions";

export function ReconcileNetlifyPanel() {
  const [pending, startTransition] = useTransition();
  const [pendingMode, setPendingMode] = useState<"dry_run" | "apply" | null>(null);
  const [dryRunResult, setDryRunResult] = useState<NetlifyReconcileResult | null>(null);
  const [applyResult, setApplyResult] = useState<NetlifyReconcileResult | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);

  // Server Action wrapping an Edge Function can blow past Netlify's ~26s cap
  // if the Netlify API is slow; show a friendly message in that case. Same
  // pattern as the sheet panel.
  const TIMEOUT_HINT = " — the underlying job may still be running. Re-run Check drift in a minute to see current state.";

  function resetResults() {
    setDryRunResult(null);
    setApplyResult(null);
    setConfirmApply(false);
  }

  function fireDryRun() {
    resetResults();
    setPendingMode("dry_run");
    startTransition(async () => {
      try {
        const r = await netlifyReconcileAction({ apply: false });
        setDryRunResult(r);
      } catch (err) {
        setDryRunResult({
          ok: false,
          error: (err instanceof Error ? err.message : String(err)) + TIMEOUT_HINT,
        });
      } finally {
        setPendingMode(null);
      }
    });
  }

  function fireApply() {
    setApplyResult(null);
    setPendingMode("apply");
    startTransition(async () => {
      try {
        const r = await netlifyReconcileAction({ apply: true });
        setApplyResult(r);
        // Refresh drift view so the operator sees would_backfill = 0 post-apply.
        if (r.ok) {
          try {
            const refreshed = await netlifyReconcileAction({ apply: false });
            setDryRunResult(refreshed);
          } catch {
            // Refresh failed — apply still succeeded.
          }
        }
      } catch (err) {
        setApplyResult({
          ok: false,
          error: (err instanceof Error ? err.message : String(err)) + TIMEOUT_HINT,
        });
      } finally {
        setPendingMode(null);
        setConfirmApply(false);
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={fireDryRun}
          disabled={pending}
          className="px-4 py-2 bg-white text-slate-900 border border-slate-300 rounded-md text-sm font-semibold hover:bg-slate-50 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
        >
          {pendingMode === "dry_run" ? "Checking…" : "Check drift"}
        </button>
        <span className="text-xs text-slate-500">
          Window: last 24h. Excludes <code>contact</code> + <code>fastrack-funded-v1</code> (handled elsewhere).
        </span>
      </div>

      {pending && pendingMode === "dry_run" && (
        <p className="text-xs text-slate-500">
          Reading the last 24h from Netlify Forms and comparing against{" "}
          <code>leads.submissions</code>. ~5-15s.
        </p>
      )}

      {dryRunResult && !dryRunResult.ok && (
        <ErrorBox title="Check failed" message={dryRunResult.error} />
      )}

      {dryRunResult && dryRunResult.ok && (
        <DriftReport
          summary={dryRunResult}
          confirmApply={confirmApply}
          setConfirmApply={setConfirmApply}
          fireApply={fireApply}
          pending={pending}
          pendingMode={pendingMode}
        />
      )}

      {applyResult && !applyResult.ok && (
        <ErrorBox title="Back-fill failed" message={applyResult.error} />
      )}
      {applyResult && applyResult.ok && (
        <SuccessBox
          title={`Back-fill complete: ${applyResult.backfilled} ${
            applyResult.backfilled === 1 ? "row" : "rows"
          } inserted`}
          summary={`${applyResult.errors} error${applyResult.errors === 1 ? "" : "s"} • dead-letter audit rows written for each back-fill`}
          errors={applyResult.errors_detail.map((e) => `${e.netlify_id}: ${e.error}`)}
        />
      )}
    </div>
  );
}

function DriftReport({
  summary,
  confirmApply,
  setConfirmApply,
  fireApply,
  pending,
  pendingMode,
}: {
  summary: Extract<NetlifyReconcileResult, { ok: true }>;
  confirmApply: boolean;
  setConfirmApply: (v: boolean) => void;
  fireApply: () => void;
  pending: boolean;
  pendingMode: string | null;
}) {
  const allClear = summary.would_backfill === 0 && summary.errors === 0;

  return (
    <div className="space-y-3">
      <div className={`rounded-md border p-4 ${allClear ? "bg-emerald-50 border-emerald-200 text-emerald-900" : "bg-amber-50 border-amber-200 text-amber-900"}`}>
        <p className="font-semibold text-sm">
          {allClear
            ? `✓ Netlify and DB agree over the last ${summary.window_hours}h`
            : `${summary.would_backfill} submission${summary.would_backfill === 1 ? "" : "s"} in Netlify, missing from DB`}
        </p>
        <ul className="text-xs mt-2 space-y-0.5">
          <li>
            <strong>{summary.netlify_seen}</strong> submissions seen in Netlify (window: last {summary.window_hours}h)
          </li>
          <li>
            <strong>{summary.already_present}</strong> already in <code>leads.submissions</code>
          </li>
          <li>
            <strong>{summary.would_backfill}</strong> would be back-filled (drift = silent lead loss between form post and ingest)
          </li>
          {summary.errors > 0 && (
            <li className="text-rose-800">
              <strong>{summary.errors}</strong> errors during check — see details below
            </li>
          )}
        </ul>
      </div>

      {summary.backfills.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200">
            <p className="text-sm font-semibold text-slate-900">
              Missing from DB ({summary.backfills.length})
            </p>
            <p className="text-[11px] text-slate-500 mt-1">
              These submissions exist in Netlify Forms but never reached{" "}
              <code>leads.submissions</code>. Hourly reconcile cron will pick
              them up on its next run; click below to back-fill now.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Netlify ID</th>
                <th className="px-3 py-2 text-left font-semibold">Form</th>
                <th className="px-3 py-2 text-left font-semibold">Course</th>
                <th className="px-3 py-2 text-left font-semibold">Email</th>
                <th className="px-3 py-2 text-left font-semibold">Submitted</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {summary.backfills.map((b) => (
                <tr key={b.netlify_id}>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-700">
                    {b.netlify_id.slice(0, 12)}…
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-700">{b.form_name}</td>
                  <td className="px-3 py-2 text-xs text-slate-700">{b.course_id ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-700">{b.email ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {b.created_at
                      ? new Date(b.created_at).toLocaleString("en-GB", {
                          dateStyle: "short",
                          timeStyle: "short",
                        })
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {summary.errors_detail.length > 0 && (
        <div className="bg-rose-50 border border-rose-200 rounded-md p-3">
          <p className="text-xs font-semibold text-rose-900 mb-1">
            Errors during check ({summary.errors_detail.length})
          </p>
          <ul className="text-[11px] text-rose-900 list-disc list-inside space-y-0.5">
            {summary.errors_detail.slice(0, 5).map((e) => (
              <li key={e.netlify_id}>
                <code>{e.netlify_id.slice(0, 12)}…</code>: {e.error}
              </li>
            ))}
            {summary.errors_detail.length > 5 && (
              <li className="text-rose-700">…and {summary.errors_detail.length - 5} more</li>
            )}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        {!confirmApply && summary.would_backfill > 0 && (
          <button
            type="button"
            onClick={() => setConfirmApply(true)}
            disabled={pending}
            className="px-4 py-2 bg-rose-700 text-white rounded-md text-sm font-semibold hover:bg-rose-800 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
          >
            Back-fill {summary.would_backfill} now
          </button>
        )}
        {summary.would_backfill === 0 && summary.errors === 0 && (
          <p className="text-xs text-slate-500">No action needed.</p>
        )}

        {confirmApply && (
          <div className="flex items-center gap-2 bg-rose-50 border border-rose-200 rounded-md px-3 py-1.5">
            <span className="text-xs text-rose-900 font-semibold">
              Back-fill {summary.would_backfill} row{summary.would_backfill === 1 ? "" : "s"} into{" "}
              <code>leads.submissions</code>?
            </span>
            <button
              type="button"
              onClick={fireApply}
              disabled={pending}
              className="px-3 py-1 bg-rose-700 text-white rounded-md text-xs font-semibold hover:bg-rose-800 disabled:opacity-60 cursor-pointer"
            >
              {pendingMode === "apply" ? "Back-filling…" : "Yes, back-fill"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmApply(false)}
              disabled={pending}
              className="px-3 py-1 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorBox({ title, message }: { title: string; message: string }) {
  return (
    <div className="bg-rose-50 border border-rose-200 rounded-md p-4 text-sm text-rose-900">
      <p className="font-semibold mb-1">{title}</p>
      <p>{message}</p>
    </div>
  );
}

function SuccessBox({
  title,
  summary,
  errors,
}: {
  title: string;
  summary: string;
  errors: string[];
}) {
  return (
    <div className="bg-emerald-50 border border-emerald-200 rounded-md p-4 text-sm text-emerald-900">
      <p className="font-semibold mb-1">{title}</p>
      <p className="text-xs">{summary}</p>
      {errors.length > 0 && (
        <ul className="text-xs mt-2 list-disc list-inside text-rose-700">
          {errors.slice(0, 5).map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
