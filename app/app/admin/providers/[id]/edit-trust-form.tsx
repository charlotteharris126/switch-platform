"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { editProviderTrust } from "./actions";

interface Props {
  providerId: string;
  initial: {
    trustLine: string | null;
    fundingTypes: string[];
    regions: string[];
    voiceNotes: string | null;
  };
}

const FUNDING_TYPES = [
  { value: "gov", label: "Funded (gov)" },
  { value: "self", label: "Self-funded" },
  { value: "loan", label: "Loan-funded" },
];

export function EditTrustForm({ providerId, initial }: Props) {
  const [pending, startTransition] = useTransition();
  const [trustLine, setTrustLine] = useState(initial.trustLine ?? "");
  const [fundingTypes, setFundingTypes] = useState<string[]>(initial.fundingTypes ?? []);
  const [regionsText, setRegionsText] = useState((initial.regions ?? []).join(", "));
  const [voiceNotes, setVoiceNotes] = useState(initial.voiceNotes ?? "");

  function toggleFundingType(value: string) {
    setFundingTypes((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  }

  function handleSave() {
    const regions = regionsText
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

    startTransition(async () => {
      const result = await editProviderTrust({
        providerId,
        trustLine: trustLine.trim() || null,
        fundingTypes,
        regions,
        voiceNotes: voiceNotes.trim() || null,
      });
      if (result.ok) {
        toast.success("Trust content saved");
      } else {
        toast.error("Save failed", { description: result.error ?? "Unknown error." });
      }
    });
  }

  const inputClass =
    "h-9 text-xs border border-[#dad4cb] rounded-lg bg-white px-3 text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76]";
  const textareaClass =
    "text-xs border border-[#dad4cb] rounded-lg bg-white px-3 py-2 text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76] resize-y leading-relaxed";

  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-5 shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
      <h3 className="text-sm font-extrabold text-[#11242e] mb-1">Marketing trust content</h3>
      <p className="text-[11px] text-[#5a6a72] mb-4">
        Pushed to Brevo at routing time as <code className="font-mono">PROVIDER_TRUST_LINE</code> and used by{" "}
        <code className="font-mono">routing-confirm</code> to compose learner emails. Edit here, not in YAML.
      </p>

      <label className="flex flex-col gap-1 mb-4">
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Trust line</span>
        <span className="text-[10px] text-[#5a6a72] italic">
          Sits after &ldquo;This course is delivered by [Provider]. &rdquo; in learner emails. Warm, factual, confident.
          Include outcome stats inline if available. No em dashes.
        </span>
        <textarea
          value={trustLine}
          onChange={(e) => setTrustLine(e.target.value)}
          rows={4}
          disabled={pending}
          className={textareaClass}
          placeholder="They've been running funded training since 2008..."
        />
      </label>

      <div className="mb-4">
        <span className="block text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72] mb-2">Funding types</span>
        <div className="flex flex-wrap gap-2">
          {FUNDING_TYPES.map((ft) => {
            const selected = fundingTypes.includes(ft.value);
            return (
              <button
                key={ft.value}
                type="button"
                onClick={() => toggleFundingType(ft.value)}
                disabled={pending}
                className={
                  "px-4 h-9 text-xs font-bold uppercase tracking-[0.08em] rounded-full border transition-all duration-150 active:scale-[0.97] " +
                  (selected
                    ? "bg-[#cd8b76] text-white border-[#cd8b76] shadow-[0_2px_6px_rgba(205,139,118,0.35)]"
                    : "bg-white text-[#143643] border-[#dad4cb] hover:border-[#cd8b76]/60 hover:bg-[#fbf9f5] hover:-translate-y-px")
                }
              >
                {ft.label}
              </button>
            );
          })}
        </div>
      </div>

      <label className="flex flex-col gap-1 mb-4">
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Regions (comma or newline separated)</span>
        <span className="text-[10px] text-[#5a6a72] italic">
          Slugs matching files in <code className="font-mono">switchable/site/deploy/data/regions/</code>. Examples:{" "}
          <code className="font-mono">tees-valley</code>, <code className="font-mono">lift-boroughs</code>,{" "}
          <code className="font-mono">nationwide</code>.
        </span>
        <input
          className={inputClass}
          value={regionsText}
          onChange={(e) => setRegionsText(e.target.value)}
          disabled={pending}
          placeholder="tees-valley, lift-boroughs"
        />
      </label>

      <label className="flex flex-col gap-1 mb-4">
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Voice notes</span>
        <span className="text-[10px] text-[#5a6a72] italic">
          Internal notes for Claude when drafting fresh copy about this provider. Sector context, terminology
          preferences, sensitivities. Not pushed to Brevo.
        </span>
        <textarea
          value={voiceNotes}
          onChange={(e) => setVoiceNotes(e.target.value)}
          rows={3}
          disabled={pending}
          className={textareaClass}
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={pending}
          className="h-9 px-5 text-[11px] font-bold uppercase tracking-[0.08em] rounded-full bg-[#143643] text-white hover:bg-[#11242e] active:scale-[0.97] transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[#143643] shadow-[0_2px_6px_rgba(17,36,46,0.15)]"
        >
          {pending ? "Saving..." : "Save trust content"}
        </button>
      </div>
    </div>
  );
}
