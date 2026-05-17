"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

export type Preset = "2d" | "7d" | "14d" | "30d" | "lifetime";

const PRESETS: Preset[] = ["2d", "7d", "14d", "30d", "lifetime"];

const PRESET_LABEL: Record<Preset, string> = {
  "2d": "2d",
  "7d": "7d",
  "14d": "14d",
  "30d": "30d",
  "lifetime": "Lifetime",
};

interface Props {
  active: Preset | "custom";
  customFrom?: string;
  customTo?: string;
}

export function PeriodPicker({ active, customFrom, customTo }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(active === "custom");
  const [from, setFrom] = useState(customFrom ?? "");
  const [to, setTo] = useState(customTo ?? "");

  function navigate(query: string) {
    startTransition(() => {
      router.push(query);
    });
  }

  function applyCustom() {
    if (!from || !to) return;
    const params = new URLSearchParams(searchParams);
    params.set("period", "custom");
    params.set("from", from);
    params.set("to", to);
    navigate(`?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESETS.map((p) => {
        const isActive = active === p;
        const href = p === "7d" ? "?" : `?period=${p}`;
        return (
          <Link
            key={p}
            href={href}
            className={
              isActive
                ? "px-3 h-8 inline-flex items-center text-[11px] font-bold uppercase tracking-[0.08em] rounded-full bg-[#cd8b76] text-white border border-[#cd8b76]"
                : "px-3 h-8 inline-flex items-center text-[11px] font-bold uppercase tracking-[0.08em] rounded-full bg-white text-[#143643] border border-[#dad4cb] hover:border-[#cd8b76]/60"
            }
          >
            {PRESET_LABEL[p]}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={
          active === "custom"
            ? "px-3 h-8 inline-flex items-center text-[11px] font-bold uppercase tracking-[0.08em] rounded-full bg-[#cd8b76] text-white border border-[#cd8b76]"
            : "px-3 h-8 inline-flex items-center text-[11px] font-bold uppercase tracking-[0.08em] rounded-full bg-white text-[#143643] border border-[#dad4cb] hover:border-[#cd8b76]/60"
        }
        aria-expanded={open}
      >
        {active === "custom" && customFrom && customTo
          ? `${customFrom} → ${customTo}`
          : "Custom"}
      </button>
      {open ? (
        <div className="flex items-center gap-2 ml-2 px-3 py-1.5 bg-white border border-[#dad4cb] rounded-full">
          <label className="text-[10px] uppercase tracking-[1.5px] font-bold text-[#5a6a72]">
            From
          </label>
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            className="text-xs h-7 px-2 border border-[#dad4cb] rounded"
          />
          <label className="text-[10px] uppercase tracking-[1.5px] font-bold text-[#5a6a72]">
            To
          </label>
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            className="text-xs h-7 px-2 border border-[#dad4cb] rounded"
          />
          <button
            type="button"
            onClick={applyCustom}
            disabled={!from || !to || pending}
            className="px-3 h-7 inline-flex items-center text-[10px] font-bold uppercase tracking-[1.5px] rounded-full bg-[#143643] text-white disabled:opacity-50"
          >
            {pending ? "Loading" : "Apply"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
