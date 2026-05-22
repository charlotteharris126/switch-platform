"use client";

// DB ↔ Brevo (full SW_* attribute) reconcile panel. Successor to the 024
// Run024Panel: walks Brevo's contact list, projects each contact's most-
// recent submission through the canonical upsertLearnerInBrevo /
// upsertLearnerInBrevoNoMatch builders, and surfaces per-attribute drift.
//
// Flow:
//   1. Check drift → calls brevo-attribute-reconcile (apply:false). Returns
//      per-attribute drift counts + a sample list of drifting contacts.
//   2. Re-sync N → calls the same function with apply:true. Re-fires the
//      canonical upsert for every drifted contact via the same code path
//      that runs on live submission insert.

import { useState, useTransition } from "react";
import {
  type BrevoReconcileResult,
  type BrevoReconcileSummary,
  brevoAttributeReconcileAction,
} from "./reconcile-actions";

export function ReconcileBrevoPanel() {
  const [pending, startTransition] = useTransition();
  const [pendingMode, setPendingMode] = useState<"dry_run" | "apply" | null>(null);
  const [dryRunResult, setDryRunResult] = useState<BrevoReconcileResult | null>(null);
  const [applyResult, setApplyResult] = useState<BrevoReconcileResult | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);

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
        const r = await brevoAttributeReconcileAction({ apply: false });
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
        // asyncApply=true: EF kicks the work into EdgeRuntime.waitUntil and
        // returns immediately. Server Action stays under Netlify's 26s cap
        // regardless of how many contacts need updating. The completion row
        // lands in leads.dead_letter with source
        // brevo_attribute_reconcile_async_result. UI tells the operator to
        // re-check drift in ~2 minutes.
        const r = await brevoAttributeReconcileAction({ apply: true, asyncApply: true });
        setApplyResult(r);
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
          Walks every Brevo contact, projects through the canonical upsert builder, compares each SW_* attribute.
        </span>
      </div>

      {pending && pendingMode === "dry_run" && (
        <p className="text-xs text-slate-500">
          Walking Brevo contacts and diffing attributes. ~30-60s for a few hundred contacts.
        </p>
      )}

      {dryRunResult && !dryRunResult.ok && (
        <ErrorBox title="Check failed" message={dryRunResult.error} />
      )}

      {dryRunResult && dryRunResult.ok && "contacts_with_drift" in dryRunResult && (
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
        <ErrorBox title="Re-sync failed" message={applyResult.error} />
      )}
      {applyResult && applyResult.ok && "started" in applyResult && applyResult.started && (
        <SuccessBox
          title="Re-sync started — running in the background"
          summary="Each contact takes ~250ms to update so 300 contacts is ~75s. Click Check drift again in ~2 minutes to confirm the drift count has dropped."
          errors={[]}
        />
      )}
      {applyResult && applyResult.ok && "applied_count" in applyResult && (
        <SuccessBox
          title={`Re-sync complete: ${applyResult.applied_count} contact${applyResult.applied_count === 1 ? "" : "s"} updated`}
          summary={`${applyResult.errors} error${applyResult.errors === 1 ? "" : "s"} • canonical upsert path fired for each drifted contact`}
          errors={applyResult.error_messages}
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
  summary: BrevoReconcileSummary;
  confirmApply: boolean;
  setConfirmApply: (v: boolean) => void;
  fireApply: () => void;
  pending: boolean;
  pendingMode: string | null;
}) {
  const allClear = summary.contacts_with_drift === 0 && summary.errors === 0;
  const sortedAttrs = Object.entries(summary.per_attribute_drift)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-3">
      <div className={`rounded-md border p-4 ${allClear ? "bg-emerald-50 border-emerald-200 text-emerald-900" : "bg-amber-50 border-amber-200 text-amber-900"}`}>
        <p className="font-semibold text-sm">
          {allClear
            ? `✓ ${summary.processed} Brevo contacts checked, all aligned with canonical projection`
            : `${summary.contacts_with_drift} contact${summary.contacts_with_drift === 1 ? "" : "s"} drift from canonical projection`}
        </p>
        <ul className="text-xs mt-2 space-y-0.5">
          <li>
            <strong>{summary.processed}</strong> Brevo contacts walked
          </li>
          <li>
            <strong>{summary.contacts_aligned}</strong> aligned · <strong>{summary.contacts_with_drift}</strong> drifted
          </li>
          {summary.skipped_no_submission > 0 && (
            <li>
              <strong>{summary.skipped_no_submission}</strong> skipped (no matching DB submission — likely legacy contact or test data)
            </li>
          )}
          {summary.skipped_no_email > 0 && (
            <li>
              <strong>{summary.skipped_no_email}</strong> skipped (Brevo contact has no email — shouldn&apos;t happen)
            </li>
          )}
          {summary.errors > 0 && (
            <li className="text-rose-800">
              <strong>{summary.errors}</strong> errors during check
            </li>
          )}
        </ul>
      </div>

      {sortedAttrs.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200">
            <p className="text-sm font-semibold text-slate-900">
              Drift by attribute ({sortedAttrs.length} attributes affected)
            </p>
            <p className="text-[11px] text-slate-500 mt-1">
              How many contacts have a Brevo value different from the canonical projection for each attribute.
              Most common drifts first.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Attribute</th>
                <th className="px-3 py-2 text-right font-semibold">Contacts drifted</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sortedAttrs.map(([attr, count]) => (
                <tr key={attr}>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-900">{attr}</td>
                  <td className="px-3 py-2 text-xs text-slate-700 text-right">{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {summary.drift_list.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200">
            <p className="text-sm font-semibold text-slate-900">
              Drifting contacts (sample, up to 50)
            </p>
            <p className="text-[11px] text-slate-500 mt-1">
              Each row shows the contact + which attributes drifted. Apply re-fires the canonical upsert for every drifting contact (not just these 50).
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Email</th>
                <th className="px-3 py-2 text-left font-semibold">Lead</th>
                <th className="px-3 py-2 text-left font-semibold">Mode</th>
                <th className="px-3 py-2 text-left font-semibold">Drifted attrs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {summary.drift_list.map((d) => (
                <tr key={d.email}>
                  <td className="px-3 py-2 text-xs text-slate-700">{d.email}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-900">
                    <a href={`/leads/${d.submission_id}`} className="hover:underline cursor-pointer">
                      #{d.submission_id}
                    </a>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-700">{d.mode}</td>
                  <td className="px-3 py-2 text-[11px] text-slate-600 font-mono">
                    {d.drifted_attrs.slice(0, 4).join(", ")}
                    {d.drifted_attrs.length > 4 && ` +${d.drifted_attrs.length - 4} more`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {summary.error_messages.length > 0 && (
        <div className="bg-rose-50 border border-rose-200 rounded-md p-3">
          <p className="text-xs font-semibold text-rose-900 mb-1">
            Errors during check ({summary.error_messages.length})
          </p>
          <ul className="text-[11px] text-rose-900 list-disc list-inside space-y-0.5">
            {summary.error_messages.slice(0, 5).map((m, i) => (
              <li key={i}>{m}</li>
            ))}
            {summary.error_messages.length > 5 && (
              <li className="text-rose-700">…and {summary.error_messages.length - 5} more</li>
            )}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        {!confirmApply && summary.contacts_with_drift > 0 && (
          <button
            type="button"
            onClick={() => setConfirmApply(true)}
            disabled={pending}
            className="px-4 py-2 bg-rose-700 text-white rounded-md text-sm font-semibold hover:bg-rose-800 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
          >
            Re-sync {summary.contacts_with_drift} now
          </button>
        )}
        {summary.contacts_with_drift === 0 && summary.errors === 0 && (
          <p className="text-xs text-slate-500">No action needed.</p>
        )}

        {confirmApply && (
          <div className="flex items-center gap-2 bg-rose-50 border border-rose-200 rounded-md px-3 py-1.5">
            <span className="text-xs text-rose-900 font-semibold">
              Re-fire upsert for {summary.contacts_with_drift} drifted contact{summary.contacts_with_drift === 1 ? "" : "s"}?
            </span>
            <button
              type="button"
              onClick={fireApply}
              disabled={pending}
              className="px-3 py-1 bg-rose-700 text-white rounded-md text-xs font-semibold hover:bg-rose-800 disabled:opacity-60 cursor-pointer"
            >
              {pendingMode === "apply" ? "Re-syncing…" : "Yes, re-sync"}
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
