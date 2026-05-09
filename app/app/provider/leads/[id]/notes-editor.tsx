"use client";

// Editable notes panel for a lead. Single-blob (UPDATE in place) for now.
// If providers ask for a timestamped log of entries later, we'll move to
// an append-only table — but the simpler shape ships first.

import { useState, useTransition } from "react";

interface Props {
  submissionId: number;
  initialValue: string;
  onSave: (args: { submissionId: number; notes: string }) => Promise<{ ok: boolean; error?: string }>;
}

export function NotesEditor({ submissionId, initialValue, onSave }: Props) {
  const [value, setValue] = useState(initialValue);
  const [savedValue, setSavedValue] = useState(initialValue);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const dirty = value !== savedValue;

  function fire() {
    setError(null);
    startTransition(async () => {
      const result = await onSave({ submissionId, notes: value });
      if (!result.ok) {
        setError(result.error ?? "Failed to save");
        return;
      }
      setSavedValue(value);
      setSavedAt(Date.now());
    });
  }

  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={4}
        placeholder="Notes from your call, what stage they're at, what to mention next time, anything you'd want a colleague to know."
        className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-slate-400"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="text-xs text-slate-500 min-h-[1rem]">
          {dirty
            ? "Unsaved changes"
            : savedAt
              ? `Saved ${formatAgo(savedAt)}`
              : ""}
        </div>
        <div className="flex gap-2">
          {dirty && (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setValue(savedValue);
                setError(null);
              }}
              className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer disabled:cursor-not-allowed"
            >
              Discard
            </button>
          )}
          <button
            type="button"
            disabled={pending || !dirty}
            onClick={fire}
            className="px-4 py-1.5 bg-slate-900 text-white rounded-md text-xs font-semibold hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            {pending ? "Saving…" : dirty ? "Save notes" : "Saved"}
          </button>
        </div>
      </div>
      {error && (
        <div className="mt-2 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2">
          {error}
        </div>
      )}
    </div>
  );
}

function formatAgo(ms: number): string {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 60 * 60) return `${Math.floor(sec / 60)}m ago`;
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
