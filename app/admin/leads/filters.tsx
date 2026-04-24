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
    "h-9 text-xs border border-[#dad4cb] rounded-lg bg-white px-3 text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76] min-w-32";
  const inputClass =
    "h-9 text-xs border border-[#dad4cb] rounded-lg bg-white px-3 text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76]";

  return (
    <div className="flex flex-wrap gap-3 items-end bg-white border border-[#dad4cb] rounded-xl p-4 shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Search</span>
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
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Funding route</span>
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
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Course</span>
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
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Routed to</span>
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
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Status</span>
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
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">DQ</span>
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
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Has phone</span>
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
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">From</span>
        <input
          type="date"
          className={inputClass}
          defaultValue={current.from ?? ""}
          onChange={(e) => updateParam("from", e.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">To</span>
        <input
          type="date"
          className={inputClass}
          defaultValue={current.to ?? ""}
          onChange={(e) => updateParam("to", e.target.value)}
        />
      </label>

      <button
        onClick={clearAll}
        className="h-9 px-4 text-[11px] font-bold uppercase tracking-[0.08em] text-[#143643] border border-[#dad4cb] rounded-full hover:bg-[#f4f1ed] hover:border-[#cd8b76]/50"
        disabled={pending}
      >
        Clear
      </button>
    </div>
  );
}
