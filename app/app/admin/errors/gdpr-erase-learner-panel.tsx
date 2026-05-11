"use client";

// Admin panel — GDPR right-to-erasure for a single learner. Walks the
// operator through:
//   1. Enter email + reason
//   2. Click "Check what would be deleted" → dry-run, shows the receipt
//   3. Confirm → "Erase across all systems" → hard delete in DB + Brevo
//      + each provider's Google Sheet, writes an audit.erasure_requests
//      receipt
// Apply requires explicit two-step confirmation; the second-click button
// only enables after the dry-run has returned.

import { useState, useTransition } from "react";
import {
  gdprEraseLearnerAction,
  type ErasureResult,
  type ErasureSheetEntry,
} from "./reconcile-actions";

const SHEET_STATUS_LABEL: Record<ErasureSheetEntry["status"], string> = {
  deleted: "Deleted",
  failed: "Failed",
  skipped_unsupported: "Skipped (appender needs update)",
  skipped_no_webhook: "Skipped (no sheet webhook)",
};

const SHEET_STATUS_TONE: Record<ErasureSheetEntry["status"], string> = {
  deleted: "bg-emerald-50 text-emerald-900 border-emerald-200",
  failed: "bg-rose-50 text-rose-900 border-rose-200",
  skipped_unsupported: "bg-amber-50 text-amber-900 border-amber-200",
  skipped_no_webhook: "bg-slate-50 text-slate-700 border-slate-200",
};

export function GdprEraseLearnerPanel() {
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const [pendingMode, setPendingMode] = useState<"dry_run" | "apply" | null>(null);
  const [dryRun, setDryRun] = useState<ErasureResult | null>(null);
  const [applyResult, setApplyResult] = useState<ErasureResult | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);

  function reset() {
    setDryRun(null);
    setApplyResult(null);
    setConfirmApply(false);
  }

  function runDryRun() {
    if (!email.trim()) return;
    reset();
    setPendingMode("dry_run");
    startTransition(async () => {
      const r = await gdprEraseLearnerAction({
        email: email.trim(),
        apply: false,
        reason: reason.trim() || undefined,
      });
      setDryRun(r);
      setPendingMode(null);
    });
  }

  function runApply() {
    if (!email.trim() || !confirmApply) return;
    setPendingMode("apply");
    setApplyResult(null);
    startTransition(async () => {
      const r = await gdprEraseLearnerAction({
        email: email.trim(),
        apply: true,
        reason: reason.trim() || undefined,
      });
      setApplyResult(r);
      setPendingMode(null);
      setConfirmApply(false);
    });
  }

  const dryRunSummary = dryRun && dryRun.ok ? dryRun : null;
  const applySummary = applyResult && applyResult.ok ? applyResult : null;
  const dryRunError = dryRun && !dryRun.ok ? dryRun.error : null;
  const applyError = applyResult && !applyResult.ok ? applyResult.error : null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-[#5a6a72] mb-1">
            Learner email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              reset();
            }}
            placeholder="learner@example.com"
            className="w-full border border-[#dde3e6] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#cd8b76]"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-[#5a6a72] mb-1">
            Reason (for the audit receipt)
          </label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. emailed request 2026-05-11"
            className="w-full border border-[#dde3e6] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#cd8b76]"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={runDryRun}
          disabled={!email.trim() || pending}
          className="px-3 py-1.5 text-sm font-medium text-[#11242e] bg-white border border-[#11242e] rounded-md hover:bg-[#11242e] hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {pendingMode === "dry_run" ? "Checking..." : "Check what would be deleted"}
        </button>
        {dryRunSummary && dryRunSummary.submission_ids.length > 0 && (
          <>
            <label className="flex items-center gap-2 text-xs text-[#5a6a72]">
              <input
                type="checkbox"
                checked={confirmApply}
                onChange={(e) => setConfirmApply(e.target.checked)}
              />
              I&apos;ve checked the list and want to erase this learner permanently
            </label>
            <button
              type="button"
              onClick={runApply}
              disabled={!confirmApply || pending}
              className="px-3 py-1.5 text-sm font-semibold text-white bg-[#b3412e] border border-[#b3412e] rounded-md hover:bg-[#9a3527] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {pendingMode === "apply" ? "Erasing..." : "Erase across all systems"}
            </button>
          </>
        )}
      </div>

      {dryRunError && (
        <div className="text-xs text-rose-900 bg-rose-50 border border-rose-200 rounded-md p-3">
          Dry-run failed: {dryRunError}
        </div>
      )}
      {applyError && (
        <div className="text-xs text-rose-900 bg-rose-50 border border-rose-200 rounded-md p-3">
          Erase failed: {applyError}
        </div>
      )}

      {dryRunSummary && !applySummary && (
        <ResultPanel mode="dry_run" summary={dryRunSummary} />
      )}
      {applySummary && (
        <ResultPanel mode="apply" summary={applySummary} />
      )}
    </div>
  );
}

function ResultPanel({
  mode,
  summary,
}: {
  mode: "dry_run" | "apply";
  summary: {
    email: string;
    submission_ids: number[];
    supabase_result: {
      rows_deleted: {
        submissions: number;
        fastrack_submissions: number;
        enrolments: number;
        lead_notes: number;
        routing_log: number;
        dead_letter_matched: number;
      };
    };
    brevo_result: { ok: boolean; error?: string };
    sheet_result: {
      providers: ErasureSheetEntry[];
      deleted_count: number;
      failed_count: number;
    };
    erasure_request_id: number | null;
  };
}) {
  const verb = mode === "dry_run" ? "Would" : "Did";
  const rd = summary.supabase_result.rows_deleted;

  if (summary.submission_ids.length === 0) {
    return (
      <div className="text-xs text-[#5a6a72] bg-[#f4f1ed] border border-[#dde3e6] rounded-md p-3">
        No submissions found for <strong>{summary.email}</strong>.
      </div>
    );
  }

  return (
    <div className="space-y-3 border border-[#dde3e6] rounded-md p-4 bg-[#fafaf8]">
      <p className="text-xs text-[#11242e] font-semibold">
        {mode === "dry_run" ? "Dry-run receipt" : "Erasure receipt"}
        {summary.erasure_request_id != null && (
          <span className="ml-2 text-[#5a6a72] font-normal font-mono">
            (audit.erasure_requests #{summary.erasure_request_id})
          </span>
        )}
      </p>

      <div className="text-xs text-[#11242e] space-y-1">
        <div>
          <strong>Email:</strong> {summary.email}
        </div>
        <div>
          <strong>Submissions affected:</strong> {summary.submission_ids.length}{" "}
          <span className="text-[#5a6a72] font-mono">
            (#{summary.submission_ids.join(", #")})
          </span>
        </div>
      </div>

      <div className="text-xs text-[#11242e]">
        <p className="font-semibold mb-1">Supabase: {verb.toLowerCase()} delete</p>
        <ul className="ml-4 space-y-0.5">
          <li>submissions: {rd.submissions}</li>
          <li>fastrack submissions: {rd.fastrack_submissions}</li>
          <li>enrolments: {rd.enrolments}</li>
          <li>lead notes: {rd.lead_notes}</li>
          <li>routing log: {rd.routing_log}</li>
          <li>dead letter (PII scrubbed, rows kept): {rd.dead_letter_matched}</li>
        </ul>
      </div>

      <div className="text-xs text-[#11242e]">
        <p className="font-semibold mb-1">Brevo contact</p>
        {mode === "dry_run" ? (
          <p className="ml-4 text-[#5a6a72]">Will delete the contact + every list membership.</p>
        ) : summary.brevo_result.ok ? (
          <p className="ml-4 text-emerald-700">✓ Deleted</p>
        ) : (
          <p className="ml-4 text-rose-700">
            ✗ Failed: {summary.brevo_result.error ?? "unknown error"}
          </p>
        )}
      </div>

      <div className="text-xs text-[#11242e]">
        <p className="font-semibold mb-1">
          Provider sheets ({summary.sheet_result.providers.length})
        </p>
        {mode === "dry_run" ? (
          <p className="ml-4 text-[#5a6a72]">
            Will post a <code>delete_submission_id</code> request to each
            provider&apos;s sheet webhook. Providers running the canonical
            appender v3+ will return deleted=true; older appenders will be
            reported as skipped — paste the latest appender on those sheets
            to complete erasure there.
          </p>
        ) : summary.sheet_result.providers.length === 0 ? (
          <p className="ml-4 text-[#5a6a72]">No provider sheets touched this learner.</p>
        ) : (
          <ul className="ml-4 space-y-1">
            {summary.sheet_result.providers.map((p, i) => (
              <li key={i}>
                <span
                  className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${
                    SHEET_STATUS_TONE[p.status]
                  }`}
                >
                  {SHEET_STATUS_LABEL[p.status]}
                </span>{" "}
                {p.company_name ?? p.provider_id}
                {p.error && <span className="text-rose-700"> — {p.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {mode === "dry_run" && (
        <p className="text-[11px] text-[#5a6a72] italic">
          Nothing has been deleted yet. Tick the checkbox above and click
          Erase to perform the actual delete.
        </p>
      )}
    </div>
  );
}
