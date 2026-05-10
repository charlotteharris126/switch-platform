"use client";

// Demo-only test-send buttons for the provider-facing transactional
// emails. Only rendered on /admin/leads/[id] when the lead is routed
// to an is_demo provider (so test sends never accidentally fire to a
// real provider's inbox).

import { useState, useTransition } from "react";

interface Props {
  submissionId: number;
  onTestRouting: (args: { submissionId: number }) => Promise<{
    ok: boolean;
    sentTo?: string;
    portalLinkUsed?: boolean;
    error?: string;
  }>;
}

export function TestEmailButtons({ submissionId, onTestRouting }: Props) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<
    | { kind: "ok"; sentTo: string; portalLinkUsed: boolean }
    | { kind: "error"; message: string }
    | null
  >(null);

  function fireRouting() {
    setResult(null);
    startTransition(async () => {
      const r = await onTestRouting({ submissionId });
      if (r.ok) {
        setResult({
          kind: "ok",
          sentTo: r.sentTo ?? "(unknown)",
          portalLinkUsed: r.portalLinkUsed ?? false,
        });
      } else {
        setResult({ kind: "error", message: r.error ?? "Unknown error" });
      }
    });
  }

  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-violet-800 mb-1">
        Test-send (demo only)
      </p>
      <p className="text-xs text-violet-700 mb-3">
        Re-fires the &ldquo;New enquiry&rdquo; routing email to the demo
        provider&apos;s contact_email so you can verify the format. The
        callback email can be tested by ticking &ldquo;Needs callback&rdquo;
        in the Notes panel below, which fires its own email.
      </p>
      <button
        type="button"
        onClick={fireRouting}
        disabled={pending}
        className="px-3 py-1.5 text-xs font-semibold text-violet-900 bg-white border border-violet-300 rounded-md hover:bg-violet-100 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
      >
        {pending ? "Sending…" : "Re-fire routing email"}
      </button>

      {result?.kind === "ok" && (
        <div className="mt-3 text-xs text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-md p-2">
          Sent to <strong>{result.sentTo}</strong>.{" "}
          {result.portalLinkUsed
            ? "Used portal deep-link (provider has portal_enabled)."
            : "Used sheet link (portal_enabled=false on this provider)."}
        </div>
      )}
      {result?.kind === "error" && (
        <div className="mt-3 text-xs text-rose-900 bg-rose-50 border border-rose-200 rounded-md p-2">
          {result.message}
        </div>
      )}
    </div>
  );
}
