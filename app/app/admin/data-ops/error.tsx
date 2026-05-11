"use client";

// Per-route error boundary so a render-time crash in the data-ops panel
// (e.g. unexpected Server Action response shape) doesn't take down the
// whole admin layout's error page.

import { useEffect } from "react";

export default function DataOpsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("data-ops error:", error);
  }, [error]);

  return (
    <div className="max-w-2xl space-y-4 py-6">
      <h1 className="text-xl font-extrabold text-[#11242e]">Data ops, something broke</h1>
      <div className="bg-rose-50 border border-rose-200 rounded-md p-4 text-sm text-rose-900 space-y-2">
        <p className="font-semibold">Error</p>
        <p className="font-mono text-xs break-all">{error.message}</p>
        {error.digest && (
          <p className="font-mono text-[11px] text-rose-700">digest: {error.digest}</p>
        )}
      </div>
      <p className="text-sm text-[#5a6a72]">
        The underlying Edge Function is idempotent and tolerant of partial
        runs. Click reset, then run dry-run to see current state. If
        Brevo already holds the new URLs for most contacts, the previous
        apply mostly succeeded.
      </p>
      <button
        type="button"
        onClick={reset}
        className="px-4 py-2 bg-slate-900 text-white rounded-md text-sm font-semibold hover:bg-slate-800 cursor-pointer"
      >
        Reset
      </button>
    </div>
  );
}
