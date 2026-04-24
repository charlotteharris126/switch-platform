"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

type Props = {
  fundingRoutes: string[];
  courseIds: string[];
  providers: { provider_id: string; company_name: string }[];
  current: Record<string, string | undefined>;
};

export function LeadFilters({ fundingRoutes, courseIds, providers, current }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    startTransition(() => router.push(`/leads?${next.toString()}`));
  }

  function clearAll() {
    startTransition(() => router.push("/leads"));
  }

  const selectClass =
    "h-8 text-xs border border-slate-200 rounded-md bg-white px-2 text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-300 min-w-32";
  const inputClass =
    "h-8 text-xs border border-slate-200 rounded-md bg-white px-2 text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-300";

  return (
    <div className="flex flex-wrap gap-2 items-end bg-white border border-slate-200 rounded-md p-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-500">Search</span>
        <input
          className={inputClass + " w-56"}
          placeholder="name or email…"
          defaultValue={current.q ?? ""}
          onKeyDown={(e) => {
            if (e.key === "Enter") updateParam("q", (e.target as HTMLInputElement).value);
          }}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-500">Funding route</span>
        <select
          className={selectClass}
          value={current.funding_route ?? ""}
          onChange={(e) => updateParam("funding_route", e.target.value)}
        >
          <option value="">Any</option>
          {fundingRoutes.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-500">Course</span>
        <select
          className={selectClass}
          value={current.course_id ?? ""}
          onChange={(e) => updateParam("course_id", e.target.value)}
        >
          <option value="">Any</option>
          {courseIds.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-500">Routed to</span>
        <select
          className={selectClass}
          value={current.provider ?? ""}
          onChange={(e) => updateParam("provider", e.target.value)}
        >
          <option value="">Any</option>
          {providers.map((p) => (
            <option key={p.provider_id} value={p.provider_id}>
              {p.company_name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-500">Status</span>
        <select
          className={selectClass}
          value={current.routed ?? ""}
          onChange={(e) => updateParam("routed", e.target.value)}
        >
          <option value="">Any</option>
          <option value="yes">Routed</option>
          <option value="no">Unrouted</option>
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-500">DQ</span>
        <select
          className={selectClass}
          value={current.dq ?? ""}
          onChange={(e) => updateParam("dq", e.target.value)}
        >
          <option value="">Any</option>
          <option value="no">Qualified</option>
          <option value="yes">DQ'd</option>
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-500">Has phone</span>
        <select
          className={selectClass}
          value={current.has_phone ?? ""}
          onChange={(e) => updateParam("has_phone", e.target.value)}
        >
          <option value="">Any</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-500">From</span>
        <input
          type="date"
          className={inputClass}
          defaultValue={current.from ?? ""}
          onChange={(e) => updateParam("from", e.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-500">To</span>
        <input
          type="date"
          className={inputClass}
          defaultValue={current.to ?? ""}
          onChange={(e) => updateParam("to", e.target.value)}
        />
      </label>

      <button
        onClick={clearAll}
        className="h-8 px-3 text-xs text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md"
        disabled={pending}
      >
        Clear
      </button>
    </div>
  );
}
