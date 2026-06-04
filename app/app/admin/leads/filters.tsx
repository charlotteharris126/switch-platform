"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

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

const CHASED_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "email_yes", label: "Email chased" },
  { value: "email_no",  label: "No email chased" },
  { value: "sms_yes",   label: "SMS chased" },
  { value: "sms_no",    label: "No SMS chased" },
];

function parseChasedList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => CHASED_OPTIONS.some((c) => c.value === s));
}

const LEAD_STATUSES: Array<{ value: string; label: string }> = [
  // Learner statuses
  { value: "open",                    label: "Open" },
  { value: "attempt_1_no_answer",     label: "1st attempt — no answer" },
  { value: "attempt_2_no_answer",     label: "2nd attempt — no answer" },
  { value: "attempt_3_no_answer",     label: "3rd attempt — no answer" },
  { value: "cannot_reach",            label: "Cannot reach" },
  { value: "enrolment_meeting_booked",label: "Enrolment meeting booked" },
  { value: "enrolled",                label: "Enrolled" },
  { value: "presumed_enrolled",       label: "Presumed enrolled" },
  { value: "lost",                    label: "Lost" },
  // Employer statuses (Switchable for Business v1)
  { value: "engaged",                  label: "Engaged (B2B)" },
  { value: "in_progress",              label: "In progress (B2B)" },
  { value: "signed",                   label: "Signed (B2B)" },
  { value: "not_signed",               label: "Not signed (B2B)" },
  { value: "presumed_employer_signed", label: "Presumed signed (B2B)" },
];

function parseLeadStatusList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => LEAD_STATUSES.some((ls) => ls.value === s));
}

function parseEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(/[,\n]/).map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0);
}

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

  // Lead status is kept in local React state and only committed to the URL
  // when the dropdown closes. Committing on every checkbox click triggers a
  // router.push, which re-renders the server tree and closes the Radix
  // dropdown mid-interaction — so it appeared single-select even though the
  // backend supported multi. Pattern: local state for the open session, sync
  // to URL on close. Local state syncs back when the URL changes externally
  // (e.g. Clear all button).
  const urlStatuses = parseLeadStatusList(current.lead_status);
  const [draftStatuses, setDraftStatuses] = useState<string[]>(urlStatuses);
  const urlStatusesKey = urlStatuses.join(",");
  useEffect(() => {
    setDraftStatuses(parseLeadStatusList(urlStatusesKey));
  }, [urlStatusesKey]);
  const activeEmails = parseEmails(current.emails);

  function toggleLeadStatus(value: string, checked: boolean) {
    setDraftStatuses((prev) =>
      checked ? Array.from(new Set([...prev, value])) : prev.filter((s) => s !== value),
    );
  }

  function commitLeadStatuses() {
    const next = draftStatuses.join(",");
    if (next === (current.lead_status ?? "")) return;
    updateParam("lead_status", next);
  }

  function clearLeadStatus() {
    setDraftStatuses([]);
    updateParam("lead_status", "");
  }

  // Same local-state-then-commit-on-close pattern for the Chased multi-select.
  // Picking multiple criteria AND-chains them in the backend query (e.g.
  // "Email chased" + "No SMS chased" = leads emailed but not SMSed).
  const urlChased = parseChasedList(current.chased);
  const [draftChased, setDraftChased] = useState<string[]>(urlChased);
  const urlChasedKey = urlChased.join(",");
  useEffect(() => {
    setDraftChased(parseChasedList(urlChasedKey));
  }, [urlChasedKey]);

  function toggleChased(value: string, checked: boolean) {
    setDraftChased((prev) =>
      checked ? Array.from(new Set([...prev, value])) : prev.filter((s) => s !== value),
    );
  }
  function commitChased() {
    const next = draftChased.join(",");
    if (next === (current.chased ?? "")) return;
    updateParam("chased", next);
  }
  function clearChased() {
    setDraftChased([]);
    updateParam("chased", "");
  }
  const chasedTriggerLabel = draftChased.length === 0
    ? "Any"
    : draftChased.length === 1
      ? (CHASED_OPTIONS.find((c) => c.value === draftChased[0])?.label ?? draftChased[0])
      : `${draftChased.length} selected`;

  function applyEmails(raw: string) {
    const cleaned = parseEmails(raw).join(",");
    updateParam("emails", cleaned);
  }

  const triggerLabel = draftStatuses.length === 0
    ? "Any"
    : draftStatuses.length === 1
      ? (LEAD_STATUSES.find((s) => s.value === draftStatuses[0])?.label ?? draftStatuses[0])
      : `${draftStatuses.length} selected`;

  return (
    <div className="flex flex-wrap gap-3 items-end bg-white border border-[#dad4cb] rounded-xl p-4 shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Lead status</span>
        <DropdownMenu
          onOpenChange={(open) => {
            if (!open) commitLeadStatuses();
          }}
        >
          <DropdownMenuTrigger
            className={selectClass + " text-left flex items-center justify-between gap-2 cursor-pointer"}
          >
            <span className={draftStatuses.length === 0 ? "text-[#5a6a72]" : "text-[#11242e] font-semibold"}>
              {triggerLabel}
            </span>
            <span className="text-[#5a6a72]">▾</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {LEAD_STATUSES.map((s) => (
              <DropdownMenuCheckboxItem
                key={s.value}
                checked={draftStatuses.includes(s.value)}
                onCheckedChange={(checked) => toggleLeadStatus(s.value, Boolean(checked))}
                onSelect={(e) => e.preventDefault()}
              >
                {s.label}
              </DropdownMenuCheckboxItem>
            ))}
            {draftStatuses.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={clearLeadStatus}>Clear</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </label>

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

      <label className="flex flex-col gap-1 flex-1 min-w-[260px] max-w-[420px]">
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72] flex items-center gap-2">
          Emails (paste list)
          {activeEmails.length > 0 && (
            <span className="px-2 h-4 inline-flex items-center bg-[#cd8b76] text-white rounded-full text-[9px] font-bold">
              {activeEmails.length} active
            </span>
          )}
        </span>
        <textarea
          className={inputClass + " min-h-[36px] py-2 resize-y"}
          placeholder="paste emails, comma or newline separated…"
          defaultValue={current.emails ?? ""}
          onBlur={(e) => applyEmails(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              applyEmails((e.target as HTMLTextAreaElement).value);
            }
          }}
          rows={1}
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
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Matched to</span>
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
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Matched</span>
        <select
          className={selectClass}
          value={current.routed ?? ""}
          onChange={(e) => updateParam("routed", e.target.value)}
        >
          <option value="">Any</option>
          <option value="yes">Matched</option>
          <option value="no">Not matched</option>
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Re-submissions</span>
        <select
          className={selectClass}
          value={current.show_children ?? ""}
          onChange={(e) => updateParam("show_children", e.target.value)}
        >
          <option value="">Hidden (default)</option>
          <option value="yes">Shown</option>
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Chased</span>
        <DropdownMenu
          onOpenChange={(open) => {
            if (!open) commitChased();
          }}
        >
          <DropdownMenuTrigger
            className={selectClass + " text-left flex items-center justify-between gap-2 cursor-pointer"}
          >
            <span className={draftChased.length === 0 ? "text-[#5a6a72]" : "text-[#11242e] font-semibold"}>
              {chasedTriggerLabel}
            </span>
            <span className="text-[#5a6a72]">▾</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {CHASED_OPTIONS.map((c) => (
              <DropdownMenuCheckboxItem
                key={c.value}
                checked={draftChased.includes(c.value)}
                onCheckedChange={(checked) => toggleChased(c.value, Boolean(checked))}
                onSelect={(e) => e.preventDefault()}
              >
                {c.label}
              </DropdownMenuCheckboxItem>
            ))}
            {draftChased.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={clearChased}>Clear</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
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
