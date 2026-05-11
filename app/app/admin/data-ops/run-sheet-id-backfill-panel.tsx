"use client";

// One-shot panel: backfill Submission IDs into legacy sheet rows.
//
// Why: sheets that pre-date 2026-05-07 have a Submission ID column with
// blank cells for old rows. The regular reconcile / republish path can't
// match those rows because there's no ID to look up by. This panel runs
// once per provider sheet to populate the missing IDs by matching DB
// leads to sheet rows on email + course.
//
// Auto-hides: this panel is invasive (writes to provider sheets) so we
// don't auto-hide aggressively. Operator decides when the legacy is
// cleaned up. After running, the regular reconcile flow on /errors
// becomes the steady-state tool.

import { useState, useTransition } from "react";
import {
  type BackfillSheetIdProvider,
  type BackfillSheetIdResult,
  runBackfillSheetIdsAction,
} from "./actions";

interface Props {
  providers: BackfillSheetIdProvider[];
  initialProviderId: string;
}

export function RunSheetIdBackfillPanel({ providers, initialProviderId }: Props) {
  const [providerId, setProviderId] = useState<string>(initialProviderId);
  const [pending, startTransition] = useTransition();
  const [pendingMode, setPendingMode] = useState<"dry_run" | "apply" | null>(null);
  const [dryResult, setDryResult] = useState<BackfillSheetIdResult | null>(null);
  const [applyResult, setApplyResult] = useState<BackfillSheetIdResult | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);

  function reset() {
    setDryResult(null);
    setApplyResult(null);
    setConfirmApply(false);
  }

  function fire(apply: boolean) {
    if (!providerId) return;
    if (apply) setApplyResult(null);
    else reset();
    setPendingMode(apply ? "apply" : "dry_run");
    startTransition(async () => {
      try {
        const r = await runBackfillSheetIdsAction({ provider_id: providerId, apply });
        if (apply) setApplyResult(r);
        else setDryResult(r);
      } catch (err) {
        const errResult: BackfillSheetIdResult = {
          ok: false,
          error:
            (err instanceof Error ? err.message : String(err)) +
            " — the underlying job may still be running. Re-run dry-run in a minute to see current state.",
        };
        if (apply) setApplyResult(errResult);
        else setDryResult(errResult);
      } finally {
        setPendingMode(null);
        if (apply) setConfirmApply(false);
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm text-slate-700 font-medium">Provider</label>
        <select
          value={providerId}
          onChange={(e) => {
            setProviderId(e.target.value);
            reset();
          }}
          disabled={pending || providers.length === 0}
          className="border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white"
        >
          {providers.length === 0 && <option value="">No providers</option>}
          {providers.map((p) => (
            <option key={p.provider_id} value={p.provider_id}>
              {p.company_name}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => fire(false)}
          disabled={pending || !providerId}
          className="px-4 py-2 bg-white text-slate-900 border border-slate-300 rounded-md text-sm font-semibold hover:bg-slate-50 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
        >
          {pendingMode === "dry_run" ? "Checking…" : "Dry-run"}
        </button>

        {dryResult && dryResult.ok && dryResult.proposed_assignments.length > 0 && !confirmApply && (
          <button
            type="button"
            onClick={() => setConfirmApply(true)}
            disabled={pending}
            className="px-4 py-2 bg-rose-700 text-white rounded-md text-sm font-semibold hover:bg-rose-800 disabled:opacity-60 cursor-pointer"
          >
            Apply ({dryResult.proposed_assignments.length} writes)
          </button>
        )}
        {confirmApply && (
          <div className="flex items-center gap-2 bg-rose-50 border border-rose-200 rounded-md px-3 py-1.5">
            <span className="text-xs text-rose-900 font-semibold">
              Confirm — write Submission IDs to sheet?
            </span>
            <button
              type="button"
              onClick={() => fire(true)}
              disabled={pending}
              className="px-3 py-1 bg-rose-700 text-white rounded-md text-xs font-semibold hover:bg-rose-800 disabled:opacity-60 cursor-pointer"
            >
              {pendingMode === "apply" ? "Writing…" : "Yes, apply"}
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

      {pending && (
        <p className="text-xs text-slate-500">
          Reading the sheet and matching against DB. ~5-15s.
        </p>
      )}

      {dryResult && !dryResult.ok && (
        <ErrorBox title="Dry-run failed" message={dryResult.error} />
      )}

      {dryResult && dryResult.ok && <DryRunReport summary={dryResult} />}

      {applyResult && !applyResult.ok && (
        <ErrorBox title="Apply failed" message={applyResult.error} />
      )}
      {applyResult && applyResult.ok && (
        <ApplyReport summary={applyResult} />
      )}
    </div>
  );
}

function DryRunReport({ summary }: { summary: Extract<BackfillSheetIdResult, { ok: true }> }) {
  const proposed = summary.proposed_assignments;
  const skipped = summary.skipped;
  const allClear = summary.sheet_rows_unidentified === 0;
  return (
    <div className="space-y-3">
      <div className={`rounded-md border p-4 ${allClear ? "bg-emerald-50 border-emerald-200 text-emerald-900" : "bg-amber-50 border-amber-200 text-amber-900"}`}>
        <p className="font-semibold text-sm">
          {allClear
            ? `✓ ${summary.company_name} — every sheet row has a Submission ID`
            : `${summary.sheet_rows_unidentified} sheet rows missing Submission ID`}
        </p>
        {!allClear && (
          <ul className="text-xs mt-2 space-y-0.5">
            <li><strong>{proposed.length}</strong> can be matched and filled in</li>
            <li><strong>{skipped.length}</strong> cannot be matched (see below)</li>
          </ul>
        )}
      </div>

      {proposed.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200">
            <p className="text-sm font-semibold text-slate-900">Proposed (first 25 shown)</p>
            <p className="text-xs text-slate-500 mt-0.5">
              Apply will write submission_id into the Submission ID column for each of
              these sheet rows. Only the Submission ID cell is touched.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Row</th>
                <th className="px-3 py-2 text-left font-semibold">Name</th>
                <th className="px-3 py-2 text-left font-semibold">Email</th>
                <th className="px-3 py-2 text-left font-semibold">Course</th>
                <th className="px-3 py-2 text-left font-semibold">Will write ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {proposed.slice(0, 25).map((p) => (
                <tr key={p.row_index}>
                  <td className="px-3 py-2 text-xs text-slate-500 font-mono">{p.row_index}</td>
                  <td className="px-3 py-2 text-xs text-slate-900">{p.sheet.name}</td>
                  <td className="px-3 py-2 text-xs text-slate-700">{p.sheet.email}</td>
                  <td className="px-3 py-2 text-xs text-slate-700">{p.sheet.course || "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-900 font-mono">{p.submission_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {proposed.length > 25 && (
            <p className="text-xs text-slate-500 px-4 py-2 border-t border-slate-100">
              … and {proposed.length - 25} more.
            </p>
          )}
        </div>
      )}

      {skipped.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200">
            <p className="text-sm font-semibold text-slate-900">Skipped ({skipped.length})</p>
            <p className="text-xs text-slate-500 mt-0.5">
              These rows can&apos;t be auto-matched. Reasons: no email on sheet, no
              DB lead found for that email + course, or multiple DB leads
              match (ambiguous). Resolve manually on the sheet if needed.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Row</th>
                <th className="px-3 py-2 text-left font-semibold">Reason</th>
                <th className="px-3 py-2 text-left font-semibold">Sheet email</th>
                <th className="px-3 py-2 text-left font-semibold">Sheet course</th>
                <th className="px-3 py-2 text-left font-semibold">Candidate IDs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {skipped.slice(0, 25).map((s) => (
                <tr key={s.row_index}>
                  <td className="px-3 py-2 text-xs text-slate-500 font-mono">{s.row_index}</td>
                  <td className="px-3 py-2 text-xs text-rose-700">{s.reason}</td>
                  <td className="px-3 py-2 text-xs text-slate-700">{s.sheet.email ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-700">{s.sheet.course ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-700 font-mono">
                    {s.candidate_ids?.join(", ") ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {skipped.length > 25 && (
            <p className="text-xs text-slate-500 px-4 py-2 border-t border-slate-100">
              … and {skipped.length - 25} more.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ApplyReport({ summary }: { summary: Extract<BackfillSheetIdResult, { ok: true }> }) {
  const ok = summary.errors.length === 0;
  const palette = ok
    ? "bg-emerald-50 border-emerald-200 text-emerald-900"
    : "bg-amber-50 border-amber-200 text-amber-900";
  return (
    <div className={`rounded-md border p-4 ${palette}`}>
      <p className="font-semibold text-sm">
        Apply complete — {summary.applied_count} Submission IDs written
      </p>
      <ul className="text-xs mt-2 space-y-0.5">
        <li>Already populated (skipped, never overwritten): {summary.skipped_already_populated}</li>
        <li>Errors: {summary.errors.length}</li>
      </ul>
      {summary.errors.length > 0 && (
        <ul className="text-xs mt-2 list-disc list-inside">
          {summary.errors.slice(0, 5).map((m, i) => <li key={i}>{m}</li>)}
        </ul>
      )}
      <p className="text-xs mt-3">
        Next: go to <a href="/errors" className="font-semibold underline-offset-2 hover:underline">Data health</a>, run Check drift,
        then Push DB → sheet to bring the old rows into sync.
      </p>
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
