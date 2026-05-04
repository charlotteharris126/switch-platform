"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

// Catches uncaught errors in any /admin/* route. Without this, a thrown
// server error renders as a raw 500 with no recovery path. With this, the
// owner sees a friendly explanation, the error is logged client-side for
// debugging, and they can retry or go home. Per Next.js App Router error
// boundary contract: must be a client component, receives error + reset.
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Admin route error:", error);
  }, [error]);

  return (
    <div className="max-w-2xl mx-auto py-16 px-6">
      <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#cd8b76] mb-3">
        Something went wrong
      </p>
      <h1 className="text-2xl font-bold text-[#11242e] mb-3">
        This page hit an unexpected error
      </h1>
      <p className="text-sm text-[#5a6a72] mb-6">
        The error has been logged. You can retry the page, go to the overview, or open another
        section from the sidebar.
      </p>

      {error.digest ? (
        <div className="mb-6 p-3 bg-[#FAF3DC] border border-[#E9C46A] rounded text-[11px] font-mono text-[#5a6a72]">
          Error reference: <span className="text-[#11242e] font-semibold">{error.digest}</span>
        </div>
      ) : null}

      <div className="flex gap-3">
        <Button
          type="button"
          onClick={() => reset()}
          className="bg-[#287271] hover:bg-[#206462] text-white"
        >
          Retry
        </Button>
        <Link
          href="/"
          className="inline-flex items-center px-4 py-2 text-sm font-medium border border-[#dad4cb] rounded hover:bg-[#f4f1ed]"
        >
          Go to overview
        </Link>
      </div>

      {process.env.NODE_ENV === "development" ? (
        <details className="mt-8">
          <summary className="text-xs text-[#5a6a72] cursor-pointer">Stack trace (dev only)</summary>
          <pre className="mt-2 p-3 bg-[#11242e] text-[#cd8b76] text-[11px] rounded overflow-auto whitespace-pre-wrap">
            {error.message}
            {"\n\n"}
            {error.stack}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
