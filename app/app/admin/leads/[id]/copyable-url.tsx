"use client";

// Small helper: shows a URL with a one-click copy button. Used on
// /admin/leads/[id] for the per-submission fastrack + referral links
// so Charlotte can paste them straight into a hand-written email
// (Gmail etc.) without composing through Brevo.

import { useState } from "react";

export function CopyableUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for very old browsers: select-text approach. The portal
      // is HTTPS-only in practice so the modern clipboard API is fine.
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <code className="text-[11px] bg-[#f4f1ed] text-[#11242e] px-2 py-1 rounded break-all flex-1 min-w-0">
        {url}
      </code>
      <button
        type="button"
        onClick={copy}
        className="px-2.5 py-1 bg-[#11242e] text-white text-xs font-semibold rounded hover:bg-[#1f3744] cursor-pointer shrink-0"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}
