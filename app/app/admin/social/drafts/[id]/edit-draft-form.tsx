"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { editDraft, cancelDraft } from "./actions";

interface Props {
  draftId: string;
  status: string;
  initialContent: string;
  initialScheduledFor: string | null;
}

const EDITABLE_STATUSES = new Set(["pending", "approved", "failed"]);
const MAX_CONTENT_CHARS = 3000;

// Convert an ISO timestamp to the format <input type="datetime-local"> expects:
// "YYYY-MM-DDTHH:mm" in the user's local timezone.
function toDatetimeLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocal(value: string): string | null {
  if (!value) return null;
  // datetime-local is local time; new Date() reads it as local. toISOString gives UTC.
  return new Date(value).toISOString();
}

export function EditDraftForm({ draftId, status, initialContent, initialScheduledFor }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [content, setContent] = useState(initialContent);
  const [scheduledLocal, setScheduledLocal] = useState(toDatetimeLocal(initialScheduledFor));

  const editable = EDITABLE_STATUSES.has(status);
  const charsOver = content.length > MAX_CONTENT_CHARS;
  const dirty = content !== initialContent || scheduledLocal !== toDatetimeLocal(initialScheduledFor);

  function handleSave() {
    if (!editable) return;
    if (charsOver) {
      toast.warning(`Content is ${content.length} chars; LinkedIn personal cap is ${MAX_CONTENT_CHARS}.`);
      return;
    }
    startTransition(async () => {
      const result = await editDraft({
        draftId,
        content: content.trim(),
        scheduledFor: fromDatetimeLocal(scheduledLocal),
      });
      if (result.ok) {
        toast.success("Draft saved.");
        router.refresh();
      } else {
        toast.error("Save failed", { description: result.error });
      }
    });
  }

  function handleCancel() {
    if (!confirm("Cancel this draft? It'll be marked rejected and won't publish.")) return;
    startTransition(async () => {
      const result = await cancelDraft(draftId);
      if (result.ok) {
        toast.success("Draft cancelled.");
        router.push("/social/drafts");
      } else {
        toast.error("Cancel failed", { description: result.error });
      }
    });
  }

  if (!editable) {
    return (
      <div className="bg-white border border-[#dad4cb] rounded-xl p-4 text-xs text-[#5a6a72]">
        This draft is in <span className="font-bold uppercase tracking-wide text-[#143643]">{status}</span> status and can&apos;t be edited from the dashboard.
        {status === "published" ? " To remove a live post, delete it on LinkedIn directly." : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-white border border-[#dad4cb] rounded-xl p-4 shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
        <label className="flex flex-col gap-1 mb-3">
          <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Content</span>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={14}
            disabled={pending}
            className={
              "text-sm border rounded-lg bg-white px-3 py-2 text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76] resize-y whitespace-pre-wrap " +
              (charsOver ? "border-[#b3412e]" : "border-[#dad4cb]")
            }
          />
          <div className="flex items-center justify-between text-[10px] text-[#5a6a72] mt-1">
            <span>LinkedIn personal cap: {MAX_CONTENT_CHARS} chars.</span>
            <span className={charsOver ? "text-[#b3412e] font-bold" : ""}>{content.length} / {MAX_CONTENT_CHARS}</span>
          </div>
        </label>

        <label className="flex flex-col gap-1 mb-3">
          <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Scheduled for</span>
          <input
            type="datetime-local"
            value={scheduledLocal}
            onChange={(e) => setScheduledLocal(e.target.value)}
            disabled={pending}
            className="text-sm border border-[#dad4cb] rounded-lg bg-white px-3 py-2 text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76]"
          />
          <span className="text-[10px] text-[#5a6a72]">
            Cron picks up every 15 minutes after the scheduled time. Local time, your timezone.
          </span>
        </label>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={pending || !dirty || charsOver}
            className="h-9 px-5 text-[11px] font-bold uppercase tracking-[0.08em] rounded-full bg-[#143643] text-white hover:bg-[#11242e] active:scale-[0.97] transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_2px_6px_rgba(17,36,46,0.15)]"
          >
            {pending ? "Saving..." : "Save changes"}
          </button>
          {status === "failed" ? (
            <span className="text-[10px] text-[#5a6a72]">
              Saving will reset to <span className="font-bold uppercase tracking-wide text-[#143643]">approved</span> so the cron retries.
            </span>
          ) : null}
        </div>
      </div>

      <div className="bg-white border border-[#dad4cb] rounded-xl p-4">
        <p className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72] mb-2">Cancel draft</p>
        <p className="text-xs text-[#5a6a72] mb-3">
          Pulls this draft from the publishing queue. Marks it rejected. The row stays for record.
        </p>
        <button
          type="button"
          onClick={handleCancel}
          disabled={pending}
          className="h-9 px-5 text-[11px] font-bold uppercase tracking-[0.08em] rounded-full bg-white text-[#b3412e] border border-[#cd8b76] hover:bg-[#fbf9f5] active:scale-[0.97] transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {pending ? "Cancelling..." : "Cancel draft"}
        </button>
      </div>
    </div>
  );
}
