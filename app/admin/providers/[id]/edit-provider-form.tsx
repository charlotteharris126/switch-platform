"use client";

import { useState, useTransition } from "react";
import { editProvider } from "./actions";

interface Props {
  providerId: string;
  initial: {
    contactName: string | null;
    contactEmail: string;
    contactPhone: string | null;
    ccEmails: string[];
    autoRouteEnabled: boolean;
    active: boolean;
    pilotStatus: string;
    notes: string | null;
  };
}

const PILOT_STATUSES = ["proposed", "agreement_sent", "active", "paused", "churned"];

export function EditProviderForm({ providerId, initial }: Props) {
  const [pending, startTransition] = useTransition();
  const [contactName, setContactName] = useState(initial.contactName ?? "");
  const [contactEmail, setContactEmail] = useState(initial.contactEmail ?? "");
  const [contactPhone, setContactPhone] = useState(initial.contactPhone ?? "");
  const [ccEmailsText, setCcEmailsText] = useState((initial.ccEmails ?? []).join(", "));
  const [autoRouteEnabled, setAutoRouteEnabled] = useState(initial.autoRouteEnabled);
  const [active, setActive] = useState(initial.active);
  const [pilotStatus, setPilotStatus] = useState(initial.pilotStatus);
  const [notes, setNotes] = useState(initial.notes ?? "");
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  function handleSave() {
    setFeedback(null);
    const ccEmails = ccEmailsText
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

    startTransition(async () => {
      const result = await editProvider({
        providerId,
        contactName: contactName.trim() || null,
        contactEmail: contactEmail.trim(),
        contactPhone: contactPhone.trim() || null,
        ccEmails,
        autoRouteEnabled,
        active,
        pilotStatus,
        notes: notes.trim() || null,
      });
      if (result.ok) {
        setFeedback({ kind: "success", message: "Saved." });
      } else {
        setFeedback({ kind: "error", message: result.error ?? "Save failed." });
      }
    });
  }

  const inputClass =
    "h-9 text-xs border border-[#dad4cb] rounded-lg bg-white px-3 text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76]";

  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-5 shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
      <h3 className="text-sm font-extrabold text-[#11242e] mb-4">Edit provider</h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Contact name</span>
          <input className={inputClass} value={contactName} onChange={(e) => setContactName(e.target.value)} disabled={pending} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Contact email *</span>
          <input className={inputClass} type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} required disabled={pending} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Contact phone</span>
          <input className={inputClass} value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} disabled={pending} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">CC emails (comma or newline separated)</span>
          <input className={inputClass} value={ccEmailsText} onChange={(e) => setCcEmailsText(e.target.value)} disabled={pending} placeholder="ops@provider.com, billing@provider.com" />
        </label>
      </div>

      <div className="mb-4">
        <span className="block text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72] mb-2">Pilot status</span>
        <div className="flex flex-wrap gap-2">
          {PILOT_STATUSES.map((s) => {
            const selected = pilotStatus === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setPilotStatus(s)}
                disabled={pending}
                className={
                  selected
                    ? "px-4 h-9 text-xs font-bold uppercase tracking-[0.08em] rounded-full bg-[#cd8b76] text-white border border-[#cd8b76]"
                    : "px-4 h-9 text-xs font-bold uppercase tracking-[0.08em] rounded-full bg-white text-[#143643] border border-[#dad4cb] hover:border-[#cd8b76]/60"
                }
              >
                {s.replace(/_/g, " ")}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap gap-6 mb-4">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={autoRouteEnabled} onChange={(e) => setAutoRouteEnabled(e.target.checked)} disabled={pending} className="h-4 w-4 accent-[#cd8b76]" />
          <span className="text-xs font-semibold text-[#143643]">Auto-route enabled</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} disabled={pending} className="h-4 w-4 accent-[#cd8b76]" />
          <span className="text-xs font-semibold text-[#143643]">Active</span>
        </label>
      </div>

      <label className="flex flex-col gap-1 mb-4">
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Notes</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          disabled={pending}
          className="text-xs border border-[#dad4cb] rounded-lg bg-white px-3 py-2 text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76] resize-y"
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={pending || !contactEmail.trim()}
          className="h-9 px-5 text-[11px] font-bold uppercase tracking-[0.08em] rounded-full bg-[#143643] text-white hover:bg-[#11242e] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {pending ? "Saving..." : "Save changes"}
        </button>
        {feedback && (
          <span className={feedback.kind === "success" ? "text-xs text-emerald-700" : "text-xs text-[#b3412e]"}>
            {feedback.message}
          </span>
        )}
      </div>
    </div>
  );
}
