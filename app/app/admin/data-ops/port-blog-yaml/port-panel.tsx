"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  type PortBlogYamlResult,
  portBlogYamlAction,
} from "./actions";

export function PortBlogYamlPanel() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<PortBlogYamlResult | null>(null);

  function run() {
    setResult(null);
    startTransition(async () => {
      try {
        const r = await portBlogYamlAction();
        setResult(r);
      } catch (err) {
        setResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="px-4 py-2 bg-[#11242e] text-white rounded-md text-sm font-semibold hover:bg-[#1a3540] disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
      >
        {pending ? "Porting…" : "Port 4 launch drafts into CMS"}
      </button>

      {pending && (
        <p className="text-xs text-slate-500">
          Reading the launch set, checking which slugs already exist, inserting the rest. ~3-5s.
        </p>
      )}

      {result && !result.ok && (
        <div className="bg-rose-50 border border-rose-200 rounded-md p-4 text-sm text-rose-900">
          <p className="font-semibold mb-1">Port failed</p>
          <p className="font-mono text-xs break-all">{result.error}</p>
        </div>
      )}

      {result && result.ok && (
        <div className="space-y-3">
          <div
            className={`rounded-md border p-4 ${
              result.failed === 0
                ? "bg-emerald-50 border-emerald-200 text-emerald-900"
                : "bg-amber-50 border-amber-200 text-amber-900"
            }`}
          >
            <p className="font-semibold text-sm">
              {result.ported} ported · {result.skipped} skipped · {result.failed} failed
            </p>
            <p className="text-xs mt-1">
              {result.skipped > 0 && "Skipped rows were already in the CMS from a previous run (idempotent). "}
              {result.ported > 0 && (
                <>
                  Drafts are now editable in{" "}
                  <Link href="/admin/blog" className="font-semibold underline">
                    /admin/blog
                  </Link>
                  .
                </>
              )}
            </p>
          </div>

          <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Slug</th>
                  <th className="px-3 py-2 text-left font-semibold">Outcome</th>
                  <th className="px-3 py-2 text-left font-semibold">Tags</th>
                  <th className="px-3 py-2 text-left font-semibold">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.results.map((r) => (
                  <tr key={r.slug}>
                    <td className="px-3 py-2 text-xs font-mono text-slate-900">{r.slug}</td>
                    <td className="px-3 py-2 text-xs">
                      <OutcomeBadge outcome={r.outcome} />
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-700">
                      {r.outcome === "ported"
                        ? `${r.tags_linked ?? 0} linked`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {r.error && <span className="text-rose-700">{r.error}</span>}
                      {!r.error && r.unknown_tags && r.unknown_tags.length > 0 && (
                        <span>Unknown tags skipped: {r.unknown_tags.join(", ")}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: "ported" | "skipped_already_exists" | "failed" }) {
  const palette = {
    ported: "bg-emerald-100 text-emerald-900 border-emerald-200",
    skipped_already_exists: "bg-slate-100 text-slate-700 border-slate-200",
    failed: "bg-rose-100 text-rose-900 border-rose-200",
  } as const;
  const label = {
    ported: "ported",
    skipped_already_exists: "already exists",
    failed: "failed",
  } as const;
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${palette[outcome]}`}>
      {label[outcome]}
    </span>
  );
}
