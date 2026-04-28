"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { upsertManualAdSpend } from "./actions";

function yesterdayISO(): string {
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

export function PasteForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [date, setDate] = useState(yesterdayISO());
  const [spend, setSpend] = useState("");
  const [leads, setLeads] = useState("");
  const [impressions, setImpressions] = useState("");
  const [clicks, setClicks] = useState("");

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!spend.trim()) {
      toast.warning("Spend is required.");
      return;
    }
    const fd = new FormData();
    fd.set("date", date);
    fd.set("spend", spend.trim());
    fd.set("leads", leads.trim());
    fd.set("impressions", impressions.trim());
    fd.set("clicks", clicks.trim());

    startTransition(async () => {
      const res = await upsertManualAdSpend(fd);
      if (res.ok) {
        toast.success(`Saved ${date}: £${res.spend}`);
        setSpend("");
        setLeads("");
        setImpressions("");
        setClicks("");
        router.refresh();
      } else {
        toast.error("Failed", { description: res.error });
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-[#dad4cb] rounded-xl p-6 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <FieldGroup label="Date" required>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={pending}
            required
            className="w-full text-sm border border-[#dad4cb] rounded px-3 py-2 bg-white text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76]"
          />
        </FieldGroup>
        <FieldGroup label="Spend (£)" required>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            placeholder="e.g. 52.40"
            value={spend}
            onChange={(e) => setSpend(e.target.value)}
            disabled={pending}
            required
            className="w-full text-sm border border-[#dad4cb] rounded px-3 py-2 bg-white text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76]"
          />
        </FieldGroup>
        <FieldGroup label="Leads">
          <input
            type="number"
            inputMode="numeric"
            step="1"
            min="0"
            placeholder="e.g. 7"
            value={leads}
            onChange={(e) => setLeads(e.target.value)}
            disabled={pending}
            className="w-full text-sm border border-[#dad4cb] rounded px-3 py-2 bg-white text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76]"
          />
        </FieldGroup>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FieldGroup label="Impressions (optional)">
          <input
            type="number"
            inputMode="numeric"
            step="1"
            min="0"
            placeholder="e.g. 12500"
            value={impressions}
            onChange={(e) => setImpressions(e.target.value)}
            disabled={pending}
            className="w-full text-sm border border-[#dad4cb] rounded px-3 py-2 bg-white text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76]"
          />
        </FieldGroup>
        <FieldGroup label="Clicks (optional)">
          <input
            type="number"
            inputMode="numeric"
            step="1"
            min="0"
            placeholder="e.g. 320"
            value={clicks}
            onChange={(e) => setClicks(e.target.value)}
            disabled={pending}
            className="w-full text-sm border border-[#dad4cb] rounded px-3 py-2 bg-white text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76]"
          />
        </FieldGroup>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="h-9 px-4 text-xs font-bold uppercase tracking-wide rounded-full bg-[#143643] text-white hover:bg-[#11242e] disabled:opacity-40"
        >
          {pending ? "Saving..." : "Save day"}
        </button>
        <p className="text-[10px] text-[#5a6a72]">
          Re-saving the same date overwrites that day. Once Meta API ingestion goes live, automated rows take over.
        </p>
      </div>
    </form>
  );
}

function FieldGroup({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-1">
        {label}
        {required ? <span className="text-[#b3412e]"> *</span> : null}
      </span>
      {children}
    </label>
  );
}
