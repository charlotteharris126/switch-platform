"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

type Props = {
  fundingCategories: string[];
  fundingRoutes: string[];
  courseIds: string[];
  providers: { provider_id: string; company_name: string }[];
  current: Record<string, string | undefined>;
};

const CATEGORY_LABELS: Record<string, string> = {
  gov: "Government / fully funded",
  self: "Self-funded",
  loan: "Loan-funded",
};

const LEAD_STATUSES: Array<{ value: string; label: string }> = [
  { value: "",                  label: "Any" },
  { value: "open",              label: "Open" },
  { value: "enrolled",          label: "Enrolled" },
  { value: "presumed_enrolled", label: "Presumed enrolled" },
  { value: "cannot_reach",      label: "Cannot reach" },
  { value: "lost",              label: "Lost" },
];

export function LeadFilters({ fundingCategories, fundingRoutes, courseIds, providers, current }: Props) {
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

  const currentLeadStatus = current.lead_status ?? "";

  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-4 shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
      <div className="mb-3">
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72] block mb-2">Lead status</span>
        <div className="flex flex-wrap gap-2">
          {LEAD_STATUSES.map((s) => {
            const selected = currentLeadStatus === s.value;
            return (
              <button
                key={s.value || "any"}
                type="button"
                onClick={() => updateParam("lead_status", s.value)}
                disabled={pending}
                className={
                  "px-3 h-7 inline-flex items-center text-[10px] font-bold uppercase tracking-[0.08em] rounded-full border transition-all duration-150 active:scale-[0.97] " +
                  (selected
                    ? "bg-[#cd8b76] text-white border-[#cd8b76] shadow-[0_2px_6px_rgba(205,139,118,0.35)]"
                    : "bg-white text-[#143643] border-[#dad4cb] hover:border-[#cd8b76]/60 hover:bg-[#fbf9f5]")
                }
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
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
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Funding category</span>
        <select
          className={selectClass}
          value={current.funding_category ?? ""}
          onChange={(e) => updateParam("funding_category", e.target.value)}
        >
          <option value="">Any</option>
          {fundingCategories.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c] ?? c}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Funding scheme</span>
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
    </div>
  );
}
