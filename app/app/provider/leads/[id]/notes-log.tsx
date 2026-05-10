"use client";

// Append-only notes log. Compose form at top, list of notes below
// (newest first). Each note shows author display name + relative time.

import { useState, useTransition } from "react";

export interface NoteRow {
  id: number;
  body: string;
  created_at: string;
  author: string;
}

interface Props {
  submissionId: number;
  notes: NoteRow[];
  onAdd: (args: { submissionId: number; body: string }) => Promise<{ ok: boolean; error?: string }>;
}

export function NotesLog({ submissionId, notes, onAdd }: Props) {
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const canSubmit = draft.trim().length > 0 && !pending;

  function fire() {
    if (!canSubmit) return;
    setError(null);
    startTransition(async () => {
      const result = await onAdd({ submissionId, body: draft });
      if (!result.ok) {
        setError(result.error ?? "Failed to save");
        return;
      }
      setDraft("");
    });
  }

  return (
    <div className="flex flex-col h-full">
      {/* Compose */}
      <div className="space-y-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          placeholder="Add a note: what they said, what's next, anything to remember."
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              fire();
            }
          }}
          className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-slate-400 resize-none"
        />
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-slate-400">
            <kbd className="px-1 py-0.5 border border-slate-200 rounded bg-slate-50">⌘</kbd>{" "}
            <kbd className="px-1 py-0.5 border border-slate-200 rounded bg-slate-50">Enter</kbd>{" "}
            to save
          </p>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={fire}
            className="px-4 py-1.5 bg-slate-900 text-white rounded-md text-sm font-semibold hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            {pending ? "Saving…" : "Add note"}
          </button>
        </div>
        {error && (
          <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2">
            {error}
          </div>
        )}
      </div>

      {/* Log */}
      <div className="mt-5 border-t border-slate-100 pt-4 flex-1 overflow-y-auto">
        {notes.length === 0 ? (
          <p className="text-sm text-slate-400 italic">
            No notes yet. Your first note will appear here.
          </p>
        ) : (
          <ul className="space-y-3">
            {notes.map((n) => (
              <li key={n.id} className="bg-amber-50 border border-amber-200 rounded-md p-3">
                <div className="flex items-baseline justify-between gap-2 text-xs text-amber-800 mb-1">
                  <span className="font-semibold">{n.author}</span>
                  <span className="text-amber-600 tabular-nums">{formatWhen(n.created_at)}</span>
                </div>
                <p className="text-sm text-amber-900 whitespace-pre-wrap break-words">{n.body}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function formatWhen(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  if (sec < 60 * 60) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 24 * 60 * 60) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 7 * 24 * 60 * 60) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
