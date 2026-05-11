"use client";

// Sheet ↔ DB reconcile panel. Bidirectional cure for any drift surfaced
// by the daily `sheet-drift-reconcile-daily` cron (or operator suspicion).
//
// Flow:
//   1. Pick a provider (only providers with a sheet_webhook_url shown).
//   2. "Check drift" → calls reconcile-sheet-to-db (dry-run). Returns the
//      list of leads where sheet differs from DB, classified by drift kind.
//   3. Pick the apply direction:
//      - "Apply selected sheet → DB" — when the provider's been editing the
//        sheet and DB needs to catch up (WYK 2026-05-09 pattern).
//      - "Push DB → sheet" — when DB has been edited via admin/portal and
//        the sheet hasn't caught up. Calls republish-provider-sheet.
//   4. Apply runs the chosen direction. Audit log captures every change.
//   5. Re-run dry-run to confirm drift_eligible_total = 0.

import { useMemo, useState, useTransition } from "react";
import {
  type ReconcileProposedChange,
  type ReconcileSheetToDbResult,
  type RepublishSheetResult,
  reconcileSheetToDbAction,
  republishSheetAction,
} from "./reconcile-actions";

export interface ReconcileProvider {
  provider_id: string;
  company_name: string;
}

const KIND_LABEL: Record<ReconcileProposedChange["kind"], string> = {
  db_open_sheet_terminal: "DB still open, sheet moved on",
  db_terminal_sheet_other: "Different terminal status on each side",
  db_missing_sheet_terminal: "No DB enrolment row, sheet has terminal",
};

export function ReconcileSheetPanel({
  providers,
  initialProviderId,
}: {
  providers: ReconcileProvider[];
  initialProviderId: string;
}) {
  const [providerId, setProviderId] = useState<string>(initialProviderId);
  const [pending, startTransition] = useTransition();
  const [pendingMode, setPendingMode] = useState<
    | "dry_run"
    | "apply_sheet_to_db"
    | "republish_dry_run"
    | "republish_apply"
    | null
  >(null);
  const [dryRunResult, setDryRunResult] = useState<ReconcileSheetToDbResult | null>(null);
  const [applyResult, setApplyResult] = useState<ReconcileSheetToDbResult | null>(null);
  const [republishResult, setRepublishResult] = useState<RepublishSheetResult | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmApply, setConfirmApply] = useState<"sheet_to_db" | "db_to_sheet" | null>(null);

  function resetResults() {
    setDryRunResult(null);
    setApplyResult(null);
    setRepublishResult(null);
    setSelectedIds(new Set());
    setConfirmApply(null);
  }

  // Server Actions that wrap a long-running Edge Function (republish over
  // many rows, or reconcile over a big drift list) can blow past Netlify's
  // ~26s Server Action cap. The Edge Function keeps writing in the
  // background up to ~150s; only the HTTP round-trip to the browser dies.
  // Catch the throw, show a friendly message, tell the operator to re-run
  // the dry-run to see the actual landed state.
  const TIMEOUT_HINT = " — the underlying job may still be running in the background. Re-run Check drift in a minute to see current state.";

  function fireDryRun() {
    if (!providerId) return;
    resetResults();
    setPendingMode("dry_run");
    startTransition(async () => {
      try {
        const r = await reconcileSheetToDbAction({ provider_id: providerId, apply: false });
        setDryRunResult(r);
        if (r.ok && r.proposed_changes.length > 0) {
          // Pre-select all eligible by default
          setSelectedIds(new Set(r.proposed_changes.map((c) => c.submission_id)));
        }
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

  function fireApplySheetToDb() {
    if (!providerId || selectedIds.size === 0) return;
    setApplyResult(null);
    setPendingMode("apply_sheet_to_db");
    startTransition(async () => {
      try {
        const r = await reconcileSheetToDbAction({
          provider_id: providerId,
          apply: true,
          submission_ids: [...selectedIds],
        });
        setApplyResult(r);
        // Refresh the dry-run view so the operator can see drift = 0
        if (r.ok) {
          try {
            const refreshed = await reconcileSheetToDbAction({ provider_id: providerId, apply: false });
            setDryRunResult(refreshed);
            if (refreshed.ok) {
              setSelectedIds(new Set(refreshed.proposed_changes.map((c) => c.submission_id)));
            }
          } catch {
            // Refresh failed — surface the apply result, operator can manually re-check.
          }
        }
      } catch (err) {
        setApplyResult({
          ok: false,
          error: (err instanceof Error ? err.message : String(err)) + TIMEOUT_HINT,
        });
      } finally {
        setPendingMode(null);
        setConfirmApply(null);
      }
    });
  }

  function fireRepublish(apply: boolean) {
    if (!providerId) return;
    setRepublishResult(null);
    setPendingMode(apply ? "republish_apply" : "republish_dry_run");
    startTransition(async () => {
      try {
        const r = await republishSheetAction({ provider_id: providerId, apply });
        setRepublishResult(r);
      } catch (err) {
        setRepublishResult({
          ok: false,
          error: (err instanceof Error ? err.message : String(err)) + TIMEOUT_HINT,
        });
      } finally {
        setPendingMode(null);
        if (apply) setConfirmApply(null);
      }
    });
  }

  const eligibleChanges = useMemo<ReconcileProposedChange[]>(
    () => (dryRunResult?.ok ? dryRunResult.proposed_changes : []),
    [dryRunResult],
  );

  const currentProvider = providers.find((p) => p.provider_id === providerId);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm text-slate-700 font-medium">Provider</label>
        <select
          value={providerId}
          onChange={(e) => {
            setProviderId(e.target.value);
            resetResults();
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
          onClick={fireDryRun}
          disabled={pending || !providerId}
          className="px-4 py-2 bg-white text-slate-900 border border-slate-300 rounded-md text-sm font-semibold hover:bg-slate-50 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
        >
          {pendingMode === "dry_run" ? "Checking…" : "Check drift"}
        </button>
      </div>

      {pending && pendingMode === "dry_run" && (
        <p className="text-xs text-slate-500">
          Reading the live sheet and comparing against DB. ~5-15s.
        </p>
      )}

      {dryRunResult && !dryRunResult.ok && (
        <ErrorBox title="Check failed" message={dryRunResult.error} />
      )}

      {dryRunResult && dryRunResult.ok && (
        <DriftReport
          summary={dryRunResult}
          eligibleChanges={eligibleChanges}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          confirmApply={confirmApply}
          setConfirmApply={setConfirmApply}
          fireApplySheetToDb={fireApplySheetToDb}
          fireRepublish={fireRepublish}
          pending={pending}
          pendingMode={pendingMode}
        />
      )}

      {applyResult && !applyResult.ok && (
        <ErrorBox title="Apply (sheet → DB) failed" message={applyResult.error} />
      )}
      {applyResult && applyResult.ok && (
        <SuccessBox
          title={`Sheet → DB applied (${applyResult.applied_count} ${
            applyResult.applied_count === 1 ? "change" : "changes"
          })`}
          summary={`${applyResult.errors.length} error${applyResult.errors.length === 1 ? "" : "s"} • ${applyResult.audit_entries.length} audit entries written`}
          errors={applyResult.errors}
        />
      )}

      {republishResult && !republishResult.ok && (
        <ErrorBox title="Republish failed" message={republishResult.error} />
      )}
      {republishResult && republishResult.ok && (
        <RepublishSummary summary={republishResult} />
      )}

      {currentProvider && (
        <p className="text-[11px] text-slate-400">
          Sheet read uses the appender&apos;s <code>read_all_status</code> mode. Sheet
          must be redeployed with the 2026-05-11 appender for the read to work. If
          you see an &quot;unknown mode&quot; error here, the sheet needs redeploy.
        </p>
      )}
    </div>
  );
}

function DriftReport({
  summary,
  eligibleChanges,
  selectedIds,
  setSelectedIds,
  confirmApply,
  setConfirmApply,
  fireApplySheetToDb,
  fireRepublish,
  pending,
  pendingMode,
}: {
  summary: Extract<ReconcileSheetToDbResult, { ok: true }>;
  eligibleChanges: ReconcileProposedChange[];
  selectedIds: Set<number>;
  setSelectedIds: (s: Set<number>) => void;
  confirmApply: "sheet_to_db" | "db_to_sheet" | null;
  setConfirmApply: (v: "sheet_to_db" | "db_to_sheet" | null) => void;
  fireApplySheetToDb: () => void;
  fireRepublish: (apply: boolean) => void;
  pending: boolean;
  pendingMode: string | null;
}) {
  const allClear = summary.drift_eligible_total === 0
    && summary.drift_skipped_db_fresher === 0;

  return (
    <div className="space-y-3">
      <div className={`rounded-md border p-4 ${allClear ? "bg-emerald-50 border-emerald-200 text-emerald-900" : "bg-amber-50 border-amber-200 text-amber-900"}`}>
        <p className="font-semibold text-sm">
          {allClear
            ? `✓ ${summary.company_name} sheet and DB agree`
            : `${summary.drift_eligible_total + summary.drift_skipped_db_fresher} row${summary.drift_eligible_total + summary.drift_skipped_db_fresher === 1 ? "" : "s"} differ`}
        </p>
        <ul className="text-xs mt-2 space-y-0.5">
          <li>
            <strong>{summary.drift_eligible_total}</strong> can be fixed by &quot;Apply sheet → DB&quot;
          </li>
          <li>
            <strong>{summary.drift_skipped_db_fresher}</strong> can be fixed by &quot;Push DB → sheet&quot; (DB is fresher)
          </li>
          {summary.drift_skipped_ambiguous > 0 && (
            <li>
              <strong>{summary.drift_skipped_ambiguous}</strong> skipped (sheet says Calling — ambiguous, sheet-edit-mirror handles attempt progression)
            </li>
          )}
          {summary.drift_skipped_target_disallowed > 0 && (
            <li>
              <strong>{summary.drift_skipped_target_disallowed}</strong> skipped (sheet wants Enrolled / Presumed enrolled — fix via the admin lead outcome path so billing audit fires)
            </li>
          )}
        </ul>
      </div>

      {eligibleChanges.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-baseline justify-between gap-3 flex-wrap">
            <p className="text-sm font-semibold text-slate-900">
              Sheet → DB candidates ({eligibleChanges.length})
            </p>
            <div className="text-xs text-slate-500">
              <button
                type="button"
                onClick={() => setSelectedIds(new Set(eligibleChanges.map((c) => c.submission_id)))}
                className="font-medium text-slate-700 hover:text-slate-900 underline-offset-2 hover:underline cursor-pointer"
              >
                Select all
              </button>
              {" · "}
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="font-medium text-slate-700 hover:text-slate-900 underline-offset-2 hover:underline cursor-pointer"
              >
                Clear
              </button>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 w-10"></th>
                <th className="px-3 py-2 text-left font-semibold">Lead</th>
                <th className="px-3 py-2 text-left font-semibold">Drift kind</th>
                <th className="px-3 py-2 text-left font-semibold">From</th>
                <th className="px-3 py-2 text-left font-semibold">To</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {eligibleChanges.map((c) => {
                const checked = selectedIds.has(c.submission_id);
                return (
                  <tr key={c.submission_id}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const next = new Set(selectedIds);
                          if (e.target.checked) next.add(c.submission_id);
                          else next.delete(c.submission_id);
                          setSelectedIds(next);
                        }}
                        className="cursor-pointer"
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-900">
                      <a href={`/leads/${c.submission_id}`} className="hover:underline cursor-pointer">
                        #{c.submission_id}
                      </a>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-700">{KIND_LABEL[c.kind]}</td>
                    <td className="px-3 py-2 text-xs text-slate-700">{c.from_status}</td>
                    <td className="px-3 py-2 text-xs text-slate-700">
                      {c.to_status}
                      {c.lost_reason && (
                        <span className="text-slate-400"> · {c.lost_reason}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        {!confirmApply && summary.drift_eligible_total > 0 && (
          <button
            type="button"
            onClick={() => setConfirmApply("sheet_to_db")}
            disabled={pending || selectedIds.size === 0}
            className="px-4 py-2 bg-rose-700 text-white rounded-md text-sm font-semibold hover:bg-rose-800 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
          >
            Apply selected sheet → DB ({selectedIds.size})
          </button>
        )}
        {!confirmApply && summary.drift_skipped_db_fresher > 0 && (
          <button
            type="button"
            onClick={() => setConfirmApply("db_to_sheet")}
            disabled={pending}
            className="px-4 py-2 bg-slate-700 text-white rounded-md text-sm font-semibold hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
          >
            Push DB → sheet (republish)
          </button>
        )}
        {summary.drift_eligible_total === 0 && summary.drift_skipped_db_fresher === 0 && (
          <p className="text-xs text-slate-500">No action needed.</p>
        )}

        {confirmApply === "sheet_to_db" && (
          <div className="flex items-center gap-2 bg-rose-50 border border-rose-200 rounded-md px-3 py-1.5">
            <span className="text-xs text-rose-900 font-semibold">
              Apply {selectedIds.size} sheet → DB change{selectedIds.size === 1 ? "" : "s"}?
            </span>
            <button
              type="button"
              onClick={fireApplySheetToDb}
              disabled={pending}
              className="px-3 py-1 bg-rose-700 text-white rounded-md text-xs font-semibold hover:bg-rose-800 disabled:opacity-60 cursor-pointer"
            >
              {pendingMode === "apply_sheet_to_db" ? "Applying…" : "Yes, apply"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmApply(null)}
              disabled={pending}
              className="px-3 py-1 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              Cancel
            </button>
          </div>
        )}

        {confirmApply === "db_to_sheet" && (
          <div className="flex items-center gap-2 bg-slate-100 border border-slate-300 rounded-md px-3 py-1.5">
            <span className="text-xs text-slate-900 font-semibold">
              Push DB → sheet for all routed leads. Dry-run first?
            </span>
            <button
              type="button"
              onClick={() => fireRepublish(false)}
              disabled={pending}
              className="px-3 py-1 bg-slate-200 text-slate-900 border border-slate-300 rounded-md text-xs font-semibold hover:bg-slate-300 disabled:opacity-60 cursor-pointer"
            >
              {pendingMode === "republish_dry_run" ? "Dry-run…" : "Dry-run"}
            </button>
            <button
              type="button"
              onClick={() => fireRepublish(true)}
              disabled={pending}
              className="px-3 py-1 bg-slate-700 text-white rounded-md text-xs font-semibold hover:bg-slate-800 disabled:opacity-60 cursor-pointer"
            >
              {pendingMode === "republish_apply" ? "Pushing…" : "Apply"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmApply(null)}
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

function RepublishSummary({ summary }: { summary: Extract<RepublishSheetResult, { ok: true }> }) {
  const tone = summary.errors > 0 ? "amber" : "emerald";
  const palette = tone === "emerald"
    ? "bg-emerald-50 border-emerald-200 text-emerald-900"
    : "bg-amber-50 border-amber-200 text-amber-900";
  return (
    <div className={`rounded-md border p-4 ${palette}`}>
      <p className="font-semibold text-sm">
        Republish ({summary.mode}): {summary.leads_written} / {summary.leads_total} rows written
      </p>
      <p className="text-xs mt-1">
        Skipped (no submission_id match in sheet): {summary.leads_skipped_no_appender_ack}
        {" · "}
        Errors: {summary.errors}
      </p>
      {summary.error_messages.length > 0 && (
        <ul className="text-xs mt-2 list-disc list-inside">
          {summary.error_messages.slice(0, 5).map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
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
